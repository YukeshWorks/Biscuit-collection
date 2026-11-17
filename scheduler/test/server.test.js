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

    const created = await authed('/api/posts', { method: 'POST', body: JSON.stringify({ mediaUrl: 'https://x.test/a.jpg', caption: 'hi', publishAt: new Date(Date.now() + 3600_000).toISOString() }) });
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

test('refuses to start without a strong ADMIN_PASSWORD', async () => {
  await assert.rejects(createApp({ ADMIN_PASSWORD: 'short' }));
});
