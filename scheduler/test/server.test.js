import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';

test('login, create, list and delete posts over HTTP (dry run)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'srv-'));
  const { server } = await createApp({ ADMIN_PASSWORD: 'correct horse battery', DATA_DIR: dir }, { log: { info() {}, warn() {}, error() {} } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = (path, opts = {}) => fetch(base + path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  try {
    assert.equal((await req('/api/posts')).status, 401);
    assert.equal((await req('/api/login', { method: 'POST', body: JSON.stringify({ password: 'wrong' }) })).status, 401);

    const login = await req('/api/login', { method: 'POST', body: JSON.stringify({ password: 'correct horse battery' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const authed = (path, opts = {}) => req(path, { ...opts, headers: { cookie } });

    const bad = await authed('/api/posts', { method: 'POST', body: JSON.stringify({ mediaUrl: 'ftp://x', publishAt: 'x' }) });
    assert.equal(bad.status, 422);

    const created = await authed('/api/posts', { method: 'POST', body: JSON.stringify({ media: [{ kind: 'image', url: 'https://x.test/a.jpg' }], caption: 'hi', publishAt: new Date(Date.now() + 3600_000).toISOString() }) });
    assert.equal(created.status, 201);
    const { post } = await created.json();

    const nowRes = await authed(`/api/posts/${post.id}/publish-now`, { method: 'POST' });
    assert.equal(nowRes.status, 200);
    await new Promise((r) => setTimeout(r, 50));
    const { posts } = await (await authed('/api/posts')).json();
    assert.equal(posts[0].status, 'published');
    assert.equal(posts[0].dryRun, true);

    assert.equal((await authed(`/api/posts/${post.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await authed('/api/status')).headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await req('/../server.js')).status, 404);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(200, 2)]);

async function boot(env = {}, opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'srv-'));
  const app = await createApp({ ADMIN_PASSWORD: 'correct horse battery', DATA_DIR: dir, ...env }, { log: { info() {}, warn() {}, error() {} }, ...opts });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = (path, { headers = {}, ...opts } = {}) => fetch(base + path, { ...opts, headers: { cookie, ...headers } });
  const close = async () => { app.server.close(); await rm(dir, { recursive: true, force: true }); };
  return { ...app, base, call, dir, close };
}

test('uploads: type sniffing, public serving with ranges, cleanup on delete', async () => {
  const app = await boot();
  try {
    const up = (body, type) => app.call('/api/uploads', { method: 'POST', headers: { 'content-type': type }, body });
    assert.equal((await up(Buffer.from('not an image'), 'image/jpeg')).status, 415, 'contents sniffed');
    assert.equal((await up(JPEG, 'image/png')).status, 415, 'PNG refused (dashboard converts)');
    assert.equal((await fetch(app.base + '/api/uploads', { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: JPEG })).status, 401);

    const img = await (await up(JPEG, 'image/jpeg')).json();
    assert.match(img.file, /^[a-f0-9]{32}\.jpg$/);
    const vid = await (await up(MP4, 'video/mp4')).json();
    assert.equal(vid.kind, 'video');

    // Public (no cookie), correct type, range support.
    const pub = await fetch(`${app.base}/media/${img.file}`);
    assert.equal(pub.status, 200);
    assert.equal(pub.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await pub.arrayBuffer()), JPEG);
    const part = await fetch(`${app.base}/media/${vid.file}`, { headers: { range: 'bytes=4-11' } });
    assert.equal(part.status, 206);
    assert.equal(Buffer.from(await part.arrayBuffer()).toString(), 'ftypisom');
    assert.equal((await fetch(`${app.base}/media/..%2Fposts.json`)).status, 404);

    const created = await app.call('/api/posts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ media: [{ file: img.file }, { file: vid.file }], caption: 'carousel', publishAt: new Date(Date.now() + 3600_000).toISOString() }),
    });
    const { post } = await created.json();
    assert.equal(post.mediaType, 'CAROUSEL');

    assert.equal((await app.call(`/api/posts/${post.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${app.base}/media/${img.file}`)).status, 404, 'file removed with its post');
  } finally {
    await app.close();
  }
});

test('live publish turns uploads into PUBLIC_URL links; edit via PATCH', async () => {
  const published = [];
  const client = { dryRun: false, async whoami() { return {}; }, async quota() { return {}; }, async publish(p) { published.push(p); return { id: 'M', permalink: null, dryRun: false }; } };
  const app = await boot({ PUBLIC_URL: 'https://sched.example.com/' }, { client });
  try {
    const { file } = await (await app.call('/api/uploads', { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: JPEG })).json();
    const json = { 'content-type': 'application/json' };
    const { post } = await (await app.call('/api/posts', { method: 'POST', headers: json, body: JSON.stringify({ media: [{ file }], caption: 'v1', publishAt: new Date(Date.now() + 3600_000).toISOString() }) })).json();
    const edited = await app.call(`/api/posts/${post.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ caption: 'v2' }) });
    assert.equal((await edited.json()).post.caption, 'v2');
    await app.call(`/api/posts/${post.id}/publish-now`, { method: 'POST' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(published[0].media[0].url, `https://sched.example.com/media/${file}`);
    assert.equal(published[0].caption, 'v2');
  } finally {
    await app.close();
  }
});

test('live publish of an upload fails clearly without an https PUBLIC_URL', async () => {
  const client = { dryRun: false, async publish() { throw new Error('should not be called'); } };
  const app = await boot({}, { client });
  try {
    const { file } = await (await app.call('/api/uploads', { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: JPEG })).json();
    const { post } = await (await app.call('/api/posts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ media: [{ file }], publishAt: new Date().toISOString() }) })).json();
    await new Promise((r) => setTimeout(r, 50));
    const after = app.store.get(post.id);
    assert.equal(after.status, 'failed');
    assert.match(after.error, /PUBLIC_URL/);
  } finally {
    await app.close();
  }
});

test('v0.1 posts are migrated to the media[] format', async () => {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'mig-'));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'posts.json'), JSON.stringify([{ id: '11111111-1111-1111-1111-111111111111', status: 'scheduled', mediaType: 'REELS', mediaUrl: 'https://x/v.mp4', caption: '', publishAt: new Date(Date.now() + 3600_000).toISOString(), attempts: 0 }]));
  const { store, server } = await createApp({ ADMIN_PASSWORD: 'correct horse battery', DATA_DIR: dir }, { log: { info() {}, warn() {}, error() {} } });
  const [p] = store.list();
  assert.deepEqual(p.media, [{ kind: 'video', url: 'https://x/v.mp4' }]);
  assert.equal(p.placement, 'FEED');
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('refuses to start without a strong ADMIN_PASSWORD', async () => {
  await assert.rejects(createApp({ ADMIN_PASSWORD: 'short' }));
});
