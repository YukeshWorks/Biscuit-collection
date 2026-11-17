// Minimal client for Instagram's official Content Publishing API.
// Flow: create media container -> wait until FINISHED -> media_publish.
// Docs: https://developers.facebook.com/docs/instagram-platform/content-publishing
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

export class InstagramError extends Error {}

export function createInstagramClient({
  userId,
  accessToken,
  host = 'graph.facebook.com',
  version = 'v23.0',
  fetchImpl = globalThis.fetch,
  sleep = delay,
  pollIntervalMs = 5000,
  maxPolls = 60,
}) {
  const base = `https://${host}/${version}`;
  // Scrub every token this client has used, so a renewed token never leaks into errors either.
  const seen = new Set([accessToken]);
  const scrub = (s) => [...seen].reduce((out, t) => out.split(t).join('[token]'), String(s));

  async function call(method, path, params = {}) {
    const url = new URL(base + path);
    const init = { method, headers: { authorization: `Bearer ${accessToken}` } };
    if (method === 'GET') {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    } else {
      init.body = new URLSearchParams(params);
    }
    let res;
    try {
      res = await fetchImpl(url, init);
    } catch (err) {
      throw new InstagramError(scrub(`Network error: ${err.message}`));
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      const e = data.error ?? {};
      throw new InstagramError(scrub(e.error_user_msg || e.message || `HTTP ${res.status}`));
    }
    return data;
  }

  async function waitForContainer(containerId) {
    for (let i = 0; i < maxPolls; i++) {
      const { status_code: status, status: detail } = await call('GET', `/${containerId}`, {
        fields: 'status_code,status',
      });
      if (status === 'FINISHED') return;
      if (status === 'ERROR' || status === 'EXPIRED') {
        throw new InstagramError(`Media container ${status.toLowerCase()}${detail ? `: ${detail}` : ''}`);
      }
      await sleep(pollIntervalMs);
    }
    throw new InstagramError('Timed out waiting for Instagram to process the media.');
  }

  return {
    dryRun: false,
    setAccessToken(token) {
      accessToken = token;
      seen.add(token);
    },
    async whoami() {
      return call('GET', `/${userId}`, { fields: 'username,name' });
    },
    async publish(post, { onContainer } = {}) {
      const params = { caption: post.caption };
      if (post.mediaType === 'REELS') Object.assign(params, { media_type: 'REELS', video_url: post.mediaUrl });
      else params.image_url = post.mediaUrl;

      const { id: containerId } = await call('POST', `/${userId}/media`, params);
      await onContainer?.(containerId);
      await waitForContainer(containerId);
      const { id } = await call('POST', `/${userId}/media_publish`, { creation_id: containerId });

      let permalink = null;
      try {
        ({ permalink = null } = await call('GET', `/${id}`, { fields: 'permalink' }));
      } catch { /* permalink is nice-to-have */ }
      return { id, permalink, dryRun: false };
    },
  };
}

// Stand-in used when DRY_RUN is on or credentials are missing. Never touches the network.
export function createDryRunClient() {
  return {
    dryRun: true,
    async whoami() {
      return { username: '(dry run)' };
    },
    async publish(_post, { onContainer } = {}) {
      await onContainer?.(`dry_container_${randomUUID().slice(0, 8)}`);
      return { id: `dry_${randomUUID().slice(0, 8)}`, permalink: null, dryRun: true };
    },
  };
}
