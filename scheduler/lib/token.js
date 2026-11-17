// Keeps the Instagram access token alive by renewing it before it expires.
//
// Renewal is only offered by Meta for "Instagram API with Instagram Login" tokens
// (host graph.instagram.com): GET /refresh_access_token?grant_type=ig_refresh_token.
// The token must be at least 24h old and not yet expired. Each renewal is free and
// gives a fresh 60-day token.
//
// Renewed tokens are saved to DATA_DIR/token.json (mode 600) so they survive restarts.
// If you put a different token in .env, it wins and the saved one is discarded.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const DAY = 24 * 60 * 60 * 1000;
const RENEW_WHEN_LEFT = 50 * DAY; // renew once the token has under 50 days left (~every 10 days)
const MIN_GAP = DAY; // never try more than once a day

const fingerprint = (t) => createHash('sha256').update(String(t)).digest('hex').slice(0, 16);

export async function createTokenManager({
  envToken,
  host = 'graph.facebook.com',
  dataDir,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  onToken = () => {},
  log = console,
}) {
  const file = join(dataDir, 'token.json');
  const canRenew = host === 'graph.instagram.com';
  const source = fingerprint(envToken);

  let state = { source, accessToken: envToken, expiresAt: null, refreshedAt: null, lastAttemptAt: null, lastError: null };
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (saved.source === source && saved.accessToken) state = { ...state, ...saved };
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn?.(`[token] ignoring unreadable ${file}: ${err.message}`);
  }
  if (state.accessToken !== envToken) onToken(state.accessToken);

  async function save() {
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(tmp, file);
  }

  function due() {
    if (!canRenew) return false;
    if (state.lastAttemptAt && now() - Date.parse(state.lastAttemptAt) < MIN_GAP) return false;
    if (!state.expiresAt) return true; // unknown expiry: renewing also tells us the real expiry
    return Date.parse(state.expiresAt) - now() < RENEW_WHEN_LEFT;
  }

  async function renew() {
    state.lastAttemptAt = new Date(now()).toISOString();
    const url = new URL(`https://${host}/refresh_access_token`);
    url.searchParams.set('grant_type', 'ig_refresh_token');
    url.searchParams.set('access_token', state.accessToken);
    const scrub = (s) => String(s).split(state.accessToken).join('[token]');
    try {
      const res = await fetchImpl(url);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error || !data.access_token) {
        throw new Error(data.error?.message || `HTTP ${res.status}`);
      }
      state.accessToken = data.access_token;
      state.expiresAt = new Date(now() + Number(data.expires_in || 60 * 24 * 3600) * 1000).toISOString();
      state.refreshedAt = state.lastAttemptAt;
      state.lastError = null;
      onToken(state.accessToken);
      log.info?.(`[token] renewed; valid until ${state.expiresAt}`);
    } catch (err) {
      state.lastError = scrub(err.message).slice(0, 300);
      log.warn?.(`[token] renewal failed: ${state.lastError}`);
    }
    await save();
  }

  return {
    async check() {
      if (due()) await renew();
    },
    renew,
    status() {
      return {
        autoRenew: canRenew,
        expiresAt: state.expiresAt,
        refreshedAt: state.refreshedAt,
        lastError: state.lastError,
      };
    },
  };
}
