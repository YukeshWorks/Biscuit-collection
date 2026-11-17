import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePost } from '../lib/validate.js';
import { createStore } from '../lib/store.js';
import { createScheduler } from '../lib/scheduler.js';
import { createInstagramClient } from '../lib/instagram.js';

const future = () => new Date(Date.now() + 3600_000).toISOString();
const quiet = { info() {}, warn() {}, error() {} };

test('validatePost accepts a good post and rejects bad ones', () => {
  assert.ok(validatePost({ mediaUrl: 'https://x.test/a.jpg', caption: 'hi #art', publishAt: future() }).ok);
  assert.ok(!validatePost({ mediaUrl: 'http://x.test/a.jpg', publishAt: future() }).ok, 'http rejected');
  assert.ok(!validatePost({ mediaUrl: 'https://x.test/a.jpg', publishAt: 'nope' }).ok);
  assert.ok(!validatePost({ mediaUrl: 'https://x.test/a.jpg', publishAt: '2000-01-01T00:00:00Z' }).ok);
  assert.ok(!validatePost({ mediaUrl: 'https://x.test/a.jpg', publishAt: future(), mediaType: 'STORY' }).ok);
  const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ');
  assert.ok(!validatePost({ mediaUrl: 'https://x.test/a.jpg', publishAt: future(), caption: tags }).ok);
  assert.ok(!validatePost({ mediaUrl: 'https://x.test/a.jpg', publishAt: future(), caption: 'x'.repeat(2201) }).ok);
});

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'sched-'));
  try { await fn(await createStore(dir), dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('scheduler publishes only due posts, records results and failures', () =>
  withStore(async (store) => {
    const due = await store.create({ mediaType: 'IMAGE', mediaUrl: 'https://x/a.jpg', caption: 'a', publishAt: new Date(Date.now() - 1000).toISOString() });
    const bad = await store.create({ mediaType: 'IMAGE', mediaUrl: 'https://x/b.jpg', caption: 'boom', publishAt: new Date(Date.now() - 500).toISOString() });
    const later = await store.create({ mediaType: 'IMAGE', mediaUrl: 'https://x/c.jpg', caption: 'c', publishAt: future() });
    const client = {
      async publish(post, { onContainer }) {
        if (post.caption === 'boom') throw new Error('Media URL unreachable');
        await onContainer('c1');
        return { id: 'm1', permalink: 'https://instagram.com/p/1', dryRun: false };
      },
    };
    const s = createScheduler({ store, client, log: quiet });
    await s.tick();
    assert.equal(store.get(due.id).status, 'published');
    assert.equal(store.get(due.id).igMediaId, 'm1');
    assert.equal(store.get(due.id).containerId, 'c1');
    assert.equal(store.get(bad.id).status, 'failed');
    assert.match(store.get(bad.id).error, /unreachable/);
    assert.equal(store.get(later.id).status, 'scheduled');
  }));

test('recover marks interrupted posts failed instead of re-posting', () =>
  withStore(async (store, dir) => {
    const p = await store.create({ mediaType: 'IMAGE', mediaUrl: 'https://x/a.jpg', caption: '', publishAt: future(), status: 'publishing' });
    const reopened = await createStore(dir); // persisted to disk
    const s = createScheduler({ store: reopened, client: {}, log: quiet });
    await s.recover();
    assert.equal(reopened.get(p.id).status, 'failed');
  }));

test('instagram client runs container -> poll -> publish and scrubs the token', async () => {
  const calls = [];
  let polls = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ path: url.pathname, method: init.method, body: init.body && Object.fromEntries(init.body), auth: init.headers.authorization });
    const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
    if (url.pathname.endsWith('/media') && init.method === 'POST') return json({ id: 'C1' });
    if (url.pathname.endsWith('/C1')) return json({ status_code: ++polls < 2 ? 'IN_PROGRESS' : 'FINISHED' });
    if (url.pathname.endsWith('/media_publish')) return json({ id: 'M1' });
    if (url.pathname.endsWith('/M1')) return json({ permalink: 'https://instagram.com/p/M1' });
    return json({ error: { message: 'unexpected' } }, 400);
  };
  const ig = createInstagramClient({ userId: 'U', accessToken: 'SECRET', fetchImpl, sleep: async () => {} });
  const r = await ig.publish({ mediaType: 'REELS', mediaUrl: 'https://x/v.mp4', caption: 'hi' });
  assert.deepEqual(r, { id: 'M1', permalink: 'https://instagram.com/p/M1', dryRun: false });
  assert.equal(calls[0].body.media_type, 'REELS');
  assert.equal(calls[0].body.video_url, 'https://x/v.mp4');
  assert.equal(calls.find((c) => c.path.endsWith('/media_publish')).body.creation_id, 'C1');
  assert.ok(calls.every((c) => c.auth === 'Bearer SECRET'));

  const failing = createInstagramClient({
    userId: 'U', accessToken: 'SECRET', sleep: async () => {},
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Invalid token SECRET' } }) }),
  });
  await assert.rejects(failing.publish({ mediaType: 'IMAGE', mediaUrl: 'https://x/a.jpg', caption: '' }), (e) => !e.message.includes('SECRET'));
});
