import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTokenManager } from '../lib/token.js';

const DAY = 86400000;
const quiet = { info() {}, warn() {}, error() {} };

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'tok-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const r = responses.shift();
    return { ok: !r.error, status: r.error ? 400 : 200, json: async () => r };
  };
  fn.calls = calls;
  return fn;
}

test('renews, persists, and reuses the renewed token after restart', () =>
  withDir(async (dir) => {
    let t = Date.parse('2026-11-01T00:00:00Z');
    const now = () => t;
    const fetchImpl = fakeFetch([{ access_token: 'NEW1', expires_in: 60 * 86400 }]);
    const seen = [];
    const m = await createTokenManager({ envToken: 'ENV', host: 'graph.instagram.com', dataDir: dir, fetchImpl, now, onToken: (x) => seen.push(x), log: quiet });

    await m.check();
    assert.equal(fetchImpl.calls[0].pathname, '/refresh_access_token');
    assert.equal(fetchImpl.calls[0].searchParams.get('access_token'), 'ENV');
    assert.deepEqual(seen, ['NEW1']);
    assert.equal(m.status().expiresAt, new Date(t + 60 * DAY).toISOString());
    assert.equal((await stat(join(dir, 'token.json'))).mode & 0o777, 0o600);

    // Not due again until under 50 days remain.
    t += 5 * DAY;
    await m.check();
    assert.equal(fetchImpl.calls.length, 1);

    // Restart: saved token is loaded and handed to the client.
    const seen2 = [];
    await createTokenManager({ envToken: 'ENV', host: 'graph.instagram.com', dataDir: dir, fetchImpl, now, onToken: (x) => seen2.push(x), log: quiet });
    assert.deepEqual(seen2, ['NEW1']);

    // A different token in .env wins over the saved one.
    const seen3 = [];
    const m3 = await createTokenManager({ envToken: 'OTHER', host: 'graph.instagram.com', dataDir: dir, fetchImpl, now, onToken: (x) => seen3.push(x), log: quiet });
    assert.deepEqual(seen3, []);
    assert.equal(m3.status().expiresAt, null);
  }));

test('renews again when under 50 days remain', () =>
  withDir(async (dir) => {
    let t = Date.now();
    const fetchImpl = fakeFetch([{ access_token: 'A', expires_in: 60 * 86400 }, { access_token: 'B', expires_in: 60 * 86400 }]);
    const m = await createTokenManager({ envToken: 'ENV', host: 'graph.instagram.com', dataDir: dir, fetchImpl, now: () => t, log: quiet });
    await m.check();
    t += 11 * DAY;
    await m.check();
    assert.equal(fetchImpl.calls.length, 2);
    assert.equal(fetchImpl.calls[1].searchParams.get('access_token'), 'A');
  }));

test('failure is recorded without leaking the token, and retried at most daily', () =>
  withDir(async (dir) => {
    let t = Date.now();
    const fetchImpl = fakeFetch([{ error: { message: 'bad token ENV' } }, { access_token: 'OK', expires_in: 5184000 }]);
    const m = await createTokenManager({ envToken: 'ENV', host: 'graph.instagram.com', dataDir: dir, fetchImpl, now: () => t, log: quiet });
    await m.check();
    assert.match(m.status().lastError, /bad token \[token\]/);
    assert.ok(!(await readFile(join(dir, 'token.json'), 'utf8')).includes('bad token ENV'));
    await m.check();
    assert.equal(fetchImpl.calls.length, 1, 'no retry within 24h');
    t += DAY + 1;
    await m.check();
    assert.equal(m.status().lastError, null);
  }));

test('does nothing for Facebook Login hosts', () =>
  withDir(async (dir) => {
    const fetchImpl = fakeFetch([]);
    const m = await createTokenManager({ envToken: 'ENV', host: 'graph.facebook.com', dataDir: dir, fetchImpl, log: quiet });
    await m.check();
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal(m.status().autoRenew, false);
  }));
