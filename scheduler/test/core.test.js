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

const img = (url = 'https://x.test/a.jpg') => ({ kind: 'image', url });
const vid = (url = 'https://x.test/v.mp4') => ({ kind: 'video', url });

test('validatePost accepts good posts and derives the Instagram media type', () => {
  const v = (input) => validatePost({ publishAt: future(), ...input });
  assert.equal(v({ media: [img()], caption: 'hi #art' }).value.mediaType, 'IMAGE');
  assert.equal(v({ media: [vid()] }).value.mediaType, 'REELS');
  assert.equal(v({ media: [img(), vid(), img()] }).value.mediaType, 'CAROUSEL');
  assert.equal(v({ placement: 'STORY', media: [vid()] }).value.mediaType, 'STORIES');
  assert.equal(v({ placement: 'STORY', media: [img()], caption: 'dropped' }).value.caption, '', 'stories have no caption');
  assert.equal(v({ media: [{ url: 'https://x.test/clip.MP4?x=1' }] }).value.media[0].kind, 'video', 'kind inferred from extension');
  assert.equal(v({ media: [{ file: 'a'.repeat(32) + '.jpg' }] }).value.media[0].kind, 'image');
  // Original v0.1 shape still accepted.
  const legacy = validatePost({ mediaType: 'REELS', mediaUrl: 'https://x.test/v.mp4', publishAt: future() });
  assert.ok(legacy.ok);
  assert.equal(legacy.value.mediaType, 'REELS');
});

test('validatePost rejects bad posts', () => {
  const bad = (input) => assert.ok(!validatePost({ publishAt: future(), media: [img()], ...input }).ok, JSON.stringify(input));
  bad({ media: [] });
  bad({ media: [img('http://x.test/a.jpg')] });
  bad({ media: [{ file: '../../etc/passwd' }] });
  bad({ media: Array.from({ length: 11 }, () => img()) });
  bad({ placement: 'STORY', media: [img(), img()] });
  bad({ placement: 'REEL' });
  bad({ publishAt: 'nope' });
  bad({ publishAt: '2000-01-01T00:00:00Z' });
  bad({ caption: Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ') });
  bad({ caption: 'x'.repeat(2201) });
});

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'sched-'));
  try { await fn(await createStore(dir), dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('scheduler publishes only due posts, records results and failures', () =>
  withStore(async (store) => {
    const due = await store.create({ mediaType: 'IMAGE', media: [img()], caption: 'a', publishAt: new Date(Date.now() - 1000).toISOString() });
    const bad = await store.create({ mediaType: 'IMAGE', media: [img()], caption: 'boom', publishAt: new Date(Date.now() - 500).toISOString() });
    const later = await store.create({ mediaType: 'IMAGE', media: [img()], caption: 'c', publishAt: future() });
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
    const p = await store.create({ mediaType: 'IMAGE', media: [img()], caption: '', publishAt: future(), status: 'publishing' });
    const reopened = await createStore(dir); // persisted to disk
    const s = createScheduler({ store: reopened, client: {}, log: quiet });
    await s.recover();
    assert.equal(reopened.get(p.id).status, 'failed');
  }));

test('instagram client runs container -> poll -> publish and scrubs the token', async () => {
  const calls = [];
  let polls = 0;
  const fetchImpl = async (url, init) => {
    const body = init.body && Object.fromEntries(init.body);
    calls.push({ path: url.pathname, method: init.method, body: body && (({ access_token, ...rest }) => rest)(body), token: body?.access_token ?? url.searchParams.get('access_token') });
    const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
    if (url.pathname.endsWith('/media') && init.method === 'POST') return json({ id: 'C1' });
    if (url.pathname.endsWith('/C1')) return json({ status_code: ++polls < 2 ? 'IN_PROGRESS' : 'FINISHED' });
    if (url.pathname.endsWith('/media_publish')) return json({ id: 'M1' });
    if (url.pathname.endsWith('/M1')) return json({ permalink: 'https://instagram.com/p/M1' });
    return json({ error: { message: 'unexpected' } }, 400);
  };
  const ig = createInstagramClient({ userId: 'U', accessToken: 'SECRET', fetchImpl, sleep: async () => {} });
  const r = await ig.publish({ mediaType: 'REELS', media: [vid('https://x/v.mp4')], caption: 'hi' });
  assert.deepEqual(r, { id: 'M1', permalink: 'https://instagram.com/p/M1', dryRun: false });
  assert.equal(calls[0].body.media_type, 'REELS');
  assert.equal(calls[0].body.video_url, 'https://x/v.mp4');
  assert.equal(calls.find((c) => c.path.endsWith('/media_publish')).body.creation_id, 'C1');
  assert.ok(calls.every((c) => c.token === 'SECRET'), 'token sent as access_token param');

  const failing = createInstagramClient({
    userId: 'U', accessToken: 'SECRET', sleep: async () => {},
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Invalid token SECRET' } }) }),
  });
  await assert.rejects(failing.publish({ mediaType: 'IMAGE', media: [img()], caption: '' }), (e) => !e.message.includes('SECRET'));
});

function fakeGraph() {
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    const raw = init.body ? Object.fromEntries(init.body) : null;
    const body = raw && (({ access_token, ...rest }) => rest)(raw);
    calls.push({ path: url.pathname, method: init.method, body, query: Object.fromEntries(url.searchParams) });
    const json = (o) => ({ ok: true, status: 200, json: async () => o });
    if (url.pathname.endsWith('/media') && init.method === 'POST') return json({ id: `C${++n}` });
    if (/\/C\d+$/.test(url.pathname)) return json({ status_code: 'FINISHED' });
    if (url.pathname.endsWith('/media_publish')) return json({ id: 'M1' });
    if (url.pathname.endsWith('/content_publishing_limit')) return json({ data: [{ quota_usage: 4, config: { quota_total: 100 } }] });
    return json({ permalink: 'https://instagram.com/p/M1' });
  };
  return { calls, client: createInstagramClient({ userId: 'U', accessToken: 'T', fetchImpl, sleep: async () => {} }) };
}

test('carousel: one child container per item, then a CAROUSEL parent', async () => {
  const { calls, client } = fakeGraph();
  await client.publish({ mediaType: 'CAROUSEL', caption: 'set', media: [img('https://x/1.jpg'), vid('https://x/2.mp4')] });
  const creates = calls.filter((c) => c.path === '/v23.0/U/media');
  assert.deepEqual(creates[0].body, { is_carousel_item: 'true', image_url: 'https://x/1.jpg' });
  assert.deepEqual(creates[1].body, { is_carousel_item: 'true', video_url: 'https://x/2.mp4', media_type: 'VIDEO' });
  assert.deepEqual(creates[2].body, { media_type: 'CAROUSEL', children: 'C1,C2', caption: 'set' });
  assert.equal(calls.find((c) => c.path.endsWith('/media_publish')).body.creation_id, 'C3');
});

test('story: STORIES container without caption; quota is read', async () => {
  const { calls, client } = fakeGraph();
  await client.publish({ mediaType: 'STORIES', caption: '', media: [img('https://x/s.jpg')] });
  assert.deepEqual(calls[0].body, { media_type: 'STORIES', image_url: 'https://x/s.jpg' });
  assert.deepEqual(await client.quota(), { used: 4, total: 100 });
});
