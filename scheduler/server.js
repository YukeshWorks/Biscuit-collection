import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createStore } from './lib/store.js';
import { validatePost } from './lib/validate.js';
import { createInstagramClient, createDryRunClient } from './lib/instagram.js';
import { createScheduler } from './lib/scheduler.js';
import { createTokenManager } from './lib/token.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');
const STATIC = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.js': 'app.js',
  '/style.css': 'style.css',
  '/favicon.svg': 'favicon.svg',
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; img-src 'self' https: data:; media-src https:; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const sha = (s) => createHash('sha256').update(String(s)).digest();

export async function createApp(env = process.env, { client: injectedClient, fetchImpl, log = console } = {}) {
  const password = env.ADMIN_PASSWORD ?? '';
  if (password.length < 12) throw new Error('ADMIN_PASSWORD must be set and at least 12 characters long.');
  const passwordHash = sha(password);

  const live = env.DRY_RUN === 'false' && env.IG_USER_ID && env.IG_ACCESS_TOKEN;
  const client =
    injectedClient ??
    (live
      ? createInstagramClient({
          userId: env.IG_USER_ID,
          accessToken: env.IG_ACCESS_TOKEN,
          host: env.IG_GRAPH_HOST || 'graph.facebook.com',
          version: env.IG_API_VERSION || 'v23.0',
        })
      : createDryRunClient());

  const store = await createStore(env.DATA_DIR || './data');
  const scheduler = createScheduler({ store, client, log });
  await scheduler.recover();

  // Auto-renews the access token (live mode only). Renewed tokens go straight into the client.
  const tokens = client.dryRun
    ? null
    : await createTokenManager({
        envToken: env.IG_ACCESS_TOKEN,
        host: env.IG_GRAPH_HOST || 'graph.facebook.com',
        dataDir: env.DATA_DIR || './data',
        fetchImpl,
        onToken: (t) => client.setAccessToken?.(t),
        log,
      });

  const sessions = new Map(); // token -> expiry
  const loginFailures = new Map(); // ip -> { count, until }
  const cookieSecure = env.COOKIE_SECURE === 'true' ? '; Secure' : '';

  function authed(req) {
    const token = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie ?? '')?.[1];
    const exp = token && sessions.get(token);
    if (!exp) return false;
    if (exp < Date.now()) { sessions.delete(token); return false; }
    return true;
  }

  function send(res, status, body, headers = {}) {
    const json = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(json);
  }

  async function readJson(req) {
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw Object.assign(new Error('Expected JSON'), { status: 415 });
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 64 * 1024) throw Object.assign(new Error('Body too large'), { status: 413 });
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
  }

  async function handleApi(req, res, path) {
    const method = req.method;

    if (path === '/api/session' && method === 'GET') return send(res, 200, { authenticated: authed(req) });

    if (path === '/api/login' && method === 'POST') {
      const ip = req.socket.remoteAddress;
      const f = loginFailures.get(ip);
      if (f && f.until > Date.now()) return send(res, 429, { error: 'Too many attempts. Try again in a minute.' });
      const { password: attempt } = await readJson(req);
      if (!timingSafeEqual(sha(attempt ?? ''), passwordHash)) {
        const count = (f?.count ?? 0) + 1;
        loginFailures.set(ip, { count, until: count >= 5 ? Date.now() + 60_000 : 0 });
        return send(res, 401, { error: 'Wrong password.' });
      }
      loginFailures.delete(ip);
      const token = randomBytes(32).toString('hex');
      sessions.set(token, Date.now() + SESSION_TTL_MS);
      return send(res, 200, { ok: true }, {
        'set-cookie': `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${cookieSecure}`,
      });
    }

    if (!authed(req)) return send(res, 401, { error: 'Log in first.' });

    if (path === '/api/logout' && method === 'POST') {
      const token = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie ?? '')?.[1];
      sessions.delete(token);
      return send(res, 200, { ok: true }, { 'set-cookie': `sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${cookieSecure}` });
    }

    if (path === '/api/status' && method === 'GET') {
      return send(res, 200, { dryRun: client.dryRun, apiVersion: env.IG_API_VERSION || 'v23.0', token: tokens?.status() ?? null });
    }

    if (path === '/api/check' && method === 'POST') {
      try { return send(res, 200, { ok: true, account: await client.whoami() }); }
      catch (err) { return send(res, 502, { ok: false, error: err.message }); }
    }

    if (path === '/api/token/renew' && method === 'POST') {
      if (!tokens?.status().autoRenew) return send(res, 409, { error: 'Token renewal needs live mode with IG_GRAPH_HOST=graph.instagram.com.' });
      await tokens.renew();
      const token = tokens.status();
      return send(res, token.lastError ? 502 : 200, { token, error: token.lastError ?? undefined });
    }

    if (path === '/api/posts' && method === 'GET') {
      const posts = store.list().sort((a, b) => Date.parse(a.publishAt) - Date.parse(b.publishAt));
      return send(res, 200, { posts });
    }

    if (path === '/api/posts' && method === 'POST') {
      const { ok, errors, value } = validatePost(await readJson(req));
      if (!ok) return send(res, 422, { error: errors.join(' ') });
      const post = await store.create(value);
      scheduler.tick().catch((e) => log.error?.(e));
      return send(res, 201, { post });
    }

    const m = /^\/api\/posts\/([0-9a-f-]{36})(\/(retry|publish-now))?$/.exec(path);
    if (m) {
      const [, id, , action] = m;
      const post = store.get(id);
      if (!post) return send(res, 404, { error: 'Post not found.' });

      if (!action && method === 'DELETE') {
        if (post.status === 'publishing') return send(res, 409, { error: 'This post is publishing right now.' });
        await store.remove(id);
        return send(res, 204);
      }

      if (!action && method === 'PATCH') {
        if (!['scheduled', 'failed'].includes(post.status)) return send(res, 409, { error: 'Only scheduled or failed posts can be edited.' });
        const { ok, errors, value } = validatePost({ ...post, ...(await readJson(req)) });
        if (!ok) return send(res, 422, { error: errors.join(' ') });
        return send(res, 200, { post: await store.update(id, { ...value, status: 'scheduled', error: null }) });
      }

      if (action === 'retry' && method === 'POST') {
        if (post.status !== 'failed') return send(res, 409, { error: 'Only failed posts can be retried.' });
        const updated = await store.update(id, { status: 'scheduled', error: null, publishAt: new Date().toISOString() });
        scheduler.tick().catch((e) => log.error?.(e));
        return send(res, 200, { post: updated });
      }

      if (action === 'publish-now' && method === 'POST') {
        if (post.status !== 'scheduled') return send(res, 409, { error: 'Only scheduled posts can be published now.' });
        const updated = await store.update(id, { publishAt: new Date().toISOString() });
        scheduler.tick().catch((e) => log.error?.(e));
        return send(res, 200, { post: updated });
      }
    }

    return send(res, 404, { error: 'Not found.' });
  }

  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    try {
      if (path.startsWith('/api/')) return await handleApi(req, res, path);
      const file = STATIC[path];
      if (!file || req.method !== 'GET') return send(res, 404, { error: 'Not found.' });
      const body = await readFile(join(PUBLIC_DIR, file));
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': TYPES[extname(file)] });
      res.end(body);
    } catch (err) {
      if (!err.status) log.error?.(err);
      send(res, err.status ?? 500, { error: err.status ? err.message : 'Server error.' });
    }
  });

  return { server, scheduler, store, client, tokens };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { server, scheduler, client, tokens } = await createApp();
  if (tokens) {
    const checkToken = () => tokens.check().catch((e) => console.error(e));
    checkToken();
    setInterval(checkToken, 60 * 60 * 1000).unref(); // hourly check; renews ~every 10 days
  }
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 8787);
  scheduler.start(30_000);
  scheduler.tick();
  server.listen(port, host, () => {
    console.log(`BISCUIT Post Scheduler on http://${host}:${port} — ${client.dryRun ? 'DRY RUN (nothing is sent to Instagram)' : 'LIVE'}`);
  });
}
