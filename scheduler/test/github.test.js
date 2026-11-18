import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseIssueForm, parseWhen, zonedTimeToUtc, extractUrls, sniffKind, resolveMedia, LABELS } from '../lib/issue-post.js';
import { postFromIssue, runQueue } from '../lib/github-runner.js';

const body = ({ placement = 'Feed (photo, Reel or carousel)', when = '2026-11-20 18:30', tz = '_No response_', media, caption = 'Night sky ✨ #biscuitart' } = {}) => `### Where should it go?

${placement}

### When should it go live?

${when}

### Time zone

${tz}

### Photos or videos

${media ?? '![sky](https://github.com/user-attachments/assets/aaa)\r\n\r\nhttps://github.com/user-attachments/assets/bbb'}

### Caption

${caption}`;

test('issue form labels match the template file', async () => {
  const yml = await readFile(new URL('../../.github/ISSUE_TEMPLATE/instagram-post.yml', import.meta.url), 'utf8');
  for (const label of Object.values(LABELS)) assert.ok(yml.includes(`label: ${label}`), `template has "${label}"`);
});

test('parseIssueForm reads every field and treats _No response_ as empty', () => {
  const f = parseIssueForm(body());
  assert.equal(f.placement, 'Feed (photo, Reel or carousel)');
  assert.equal(f.when, '2026-11-20 18:30');
  assert.equal(f.timezone, '');
  assert.equal(f.caption, 'Night sky ✨ #biscuitart');
  assert.deepEqual(extractUrls(f.media), ['https://github.com/user-attachments/assets/aaa', 'https://github.com/user-attachments/assets/bbb']);
});

test('times: zones, DST, offsets, now, bad input', () => {
  assert.equal(new Date(zonedTimeToUtc(2026, 11, 20, 18, 30, 'Asia/Kolkata')).toISOString(), '2026-11-20T13:00:00.000Z');
  assert.equal(new Date(zonedTimeToUtc(2026, 7, 1, 9, 0, 'Europe/London')).toISOString(), '2026-07-01T08:00:00.000Z', 'BST');
  assert.equal(new Date(zonedTimeToUtc(2026, 1, 1, 9, 0, 'Europe/London')).toISOString(), '2026-01-01T09:00:00.000Z', 'GMT');
  assert.equal(new Date(zonedTimeToUtc(2026, 3, 8, 12, 0, 'America/New_York')).toISOString(), '2026-03-08T16:00:00.000Z', 'after DST starts');
  assert.equal(new Date(parseWhen('2026-11-20 18:30 +05:30', 'UTC').ts).toISOString(), '2026-11-20T13:00:00.000Z');
  assert.equal(new Date(parseWhen('2026-11-20T18:30Z', 'Asia/Kolkata').ts).toISOString(), '2026-11-20T18:30:00.000Z');
  assert.equal(parseWhen('NOW', 'UTC', 123).ts, 123);
  assert.ok(parseWhen('tomorrow', 'UTC').error);
  assert.ok(parseWhen('2026-13-01 10:00', 'UTC').error);
});

test('sniffKind recognises JPEG/MP4 and explains PNG/HEIC/WebP', () => {
  assert.equal(sniffKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0])).kind, 'image');
  assert.equal(sniffKind(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom')])).kind, 'video');
  assert.match(sniffKind(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic')])).error, /HEIC/);
  assert.match(sniffKind(Buffer.from([0x89, 0x50, 0x4e, 0x47])).error, /PNG/);
  assert.match(sniffKind(Buffer.from('RIFF0000WEBP')).error, /WebP/);
});

test('resolveMedia follows redirects and returns the final URL', async () => {
  const fetchImpl = async () => ({ ok: true, status: 206, url: 'https://objects.example/signed.jpg?sig=1', arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xdb]).buffer });
  assert.deepEqual(await resolveMedia('https://github.com/user-attachments/assets/aaa', fetchImpl), { kind: 'image', url: 'https://objects.example/signed.jpg?sig=1' });
  const missing = await resolveMedia('https://x', async () => ({ ok: false, status: 404 }));
  assert.match(missing.error, /404/);
});

test('postFromIssue derives type and validates', () => {
  const p = postFromIssue({ body: body({ tz: 'Asia/Kolkata' }) });
  assert.ok(p.ok, p.errors.join());
  assert.equal(p.post.mediaType, 'CAROUSEL');
  assert.equal(new Date(p.ts).toISOString(), '2026-11-20T13:00:00.000Z');
  const story = postFromIssue({ body: body({ placement: 'Story', media: 'https://a.example/1.jpg' }) });
  assert.equal(story.post.mediaType, 'STORIES');
  assert.equal(story.post.caption, '');
  const bad = postFromIssue({ body: body({ when: 'soon', tz: 'Mars/Base', media: '' }) });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 3);
});

// ---- runQueue with fake GitHub + Instagram ----
function fakeGitHub(issues) {
  const log = [];
  const comments = new Map();
  return {
    log,
    async openQueuedIssues() { return issues.filter((i) => i.state !== 'closed'); },
    async comments(n) { return comments.get(n) ?? []; },
    async comment(n, b) { log.push(['comment', n, b]); comments.set(n, [...(comments.get(n) ?? []), { body: b }]); },
    async addLabels(n, l) { log.push(['add', n, ...l]); const i = issues.find((x) => x.number === n); i.labels.push(...l.map((name) => ({ name }))); },
    async removeLabel(n, l) { log.push(['remove', n, l]); const i = issues.find((x) => x.number === n); i.labels = i.labels.filter((x) => x.name !== l); },
    async close(n) { log.push(['close', n]); issues.find((x) => x.number === n).state = 'closed'; },
  };
}
const issue = (number, b, extra = {}) => ({ number, body: b, author_association: 'OWNER', user: { login: 'owner' }, labels: [{ name: 'instagram' }], state: 'open', ...extra });
const jpegFetch = async (url) => ({ ok: true, status: 206, url: `${url}?signed`, arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer });
const quiet = { info() {}, warn() {} };

test('runQueue: publishes due posts, waits for future ones, ignores strangers', async () => {
  const now = Date.parse('2026-11-20T14:00:00Z');
  const issues = [
    issue(1, body({ tz: 'Asia/Kolkata' })), // 13:00Z, due
    issue(2, body({ when: '2026-11-21 09:00', tz: 'UTC' })), // future
    issue(3, body({ when: 'now' }), { author_association: 'NONE', user: { login: 'stranger' } }),
  ];
  const gh = fakeGitHub(issues);
  const published = [];
  const client = { async publish(p) { published.push(p); return { id: 'M1', permalink: 'https://www.instagram.com/p/M1/' }; } };
  const s = await runQueue({ github: gh, client, dryRun: false, now: () => now, fetchImpl: jpegFetch, log: quiet });
  assert.deepEqual(s, { published: 1, failed: 0, waiting: 1, invalid: 0, skipped: 1, dry: 0 });
  assert.equal(published.length, 1);
  assert.equal(published[0].mediaType, 'CAROUSEL');
  assert.ok(published[0].media.every((m) => m.url.endsWith('?signed') && m.kind === 'image'));
  assert.equal(issues[0].state, 'closed');
  assert.ok(gh.log.some(([t, n, b]) => t === 'comment' && n === 1 && b.includes('https://www.instagram.com/p/M1/')));
  assert.ok(gh.log.some(([t, n, b]) => t === 'comment' && n === 2 && b.includes('📅 Scheduled')));
  assert.ok(!gh.log.some(([, n]) => n === 3), 'stranger issue untouched');

  // Second run: no duplicate "scheduled" comment.
  const before = gh.log.length;
  await runQueue({ github: gh, client, dryRun: false, now: () => now, fetchImpl: jpegFetch, log: quiet });
  assert.equal(gh.log.length, before);
});

test('runQueue: failure labels the issue and is not retried until the label is removed', async () => {
  const issues = [issue(5, body({ when: 'now', media: 'https://a.example/x.jpg' }))];
  const gh = fakeGitHub(issues);
  let calls = 0;
  const client = { async publish() { calls++; throw new Error('Invalid OAuth access token'); } };
  const s = await runQueue({ github: gh, client, dryRun: false, fetchImpl: jpegFetch, log: quiet });
  assert.equal(s.failed, 1);
  assert.ok(issues[0].labels.some((l) => l.name === 'failed'));
  assert.ok(!issues[0].labels.some((l) => l.name === 'publishing'));
  await runQueue({ github: gh, client, dryRun: false, fetchImpl: jpegFetch, log: quiet });
  assert.equal(calls, 1, 'not retried while labelled failed');
});

test('runQueue: interrupted publish is flagged, not repeated', async () => {
  const issues = [issue(6, body({ when: 'now' }), { labels: [{ name: 'instagram' }, { name: 'publishing' }] })];
  const gh = fakeGitHub(issues);
  const client = { async publish() { throw new Error('should not be called'); } };
  await runQueue({ github: gh, client, dryRun: false, fetchImpl: jpegFetch, log: quiet });
  assert.ok(issues[0].labels.some((l) => l.name === 'failed'));
  assert.ok(gh.log.some(([t, , b]) => t === 'comment' && /may or may not be on Instagram/.test(b)));
});

test('runQueue: dry run checks once and keeps the issue open; bad media gets one clear comment', async () => {
  const pngFetch = async (url) => ({ ok: true, status: 200, url, arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer });
  const issues = [issue(7, body({ when: 'now', media: 'https://a.example/x.jpg' })), issue(8, body({ when: 'now', media: 'https://a.example/y.png' }))];
  const gh = fakeGitHub(issues);
  const fetchImpl = (u) => (u.endsWith('.png') ? pngFetch(u) : jpegFetch(u));
  const s1 = await runQueue({ github: gh, client: null, dryRun: true, fetchImpl, log: quiet });
  assert.equal(s1.dry, 1);
  assert.equal(s1.invalid, 1);
  assert.equal(issues[0].state, 'open');
  assert.ok(gh.log.some(([t, n, b]) => t === 'comment' && n === 8 && /PNG/.test(b)));
  const count = gh.log.length;
  await runQueue({ github: gh, client: null, dryRun: true, fetchImpl, log: quiet });
  assert.equal(gh.log.length, count, 'no repeated comments');
});
