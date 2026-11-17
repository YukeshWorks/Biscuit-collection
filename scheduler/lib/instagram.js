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
    // access_token as a parameter, exactly as Meta's Graph API docs show it.
    const all = { ...params, access_token: accessToken };
    const init = { method };
    if (method === 'GET') {
      for (const [k, v] of Object.entries(all)) url.searchParams.set(k, v);
    } else {
      init.body = new URLSearchParams(all);
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
    // Share of the rolling 24h publishing limit used so far.
    async quota() {
      const { data = [] } = await call('GET', `/${userId}/content_publishing_limit`, { fields: 'quota_usage,config' });
      const row = data[0] ?? {};
      return { used: row.quota_usage ?? null, total: row.config?.quota_total ?? null };
    },
    // post.media items must already carry public https `url`s (see server prepare()).
    async publish(post, { onContainer } = {}) {
      const media = post.media;
      const urlParam = (m) => (m.kind === 'video' ? { video_url: m.url } : { image_url: m.url });
      let params;
      switch (post.mediaType) {
        case 'IMAGE':
          params = { ...urlParam(media[0]), caption: post.caption };
          break;
        case 'REELS':
          params = { media_type: 'REELS', ...urlParam(media[0]), caption: post.caption };
          break;
        case 'STORIES':
          params = { media_type: 'STORIES', ...urlParam(media[0]) };
          break;
        case 'CAROUSEL': {
          const children = [];
          for (const m of media) {
            const child = { is_carousel_item: 'true', ...urlParam(m) };
            if (m.kind === 'video') child.media_type = 'VIDEO';
            const { id } = await call('POST', `/${userId}/media`, child);
            children.push(id);
          }
          for (const id of children) await waitForContainer(id);
          params = { media_type: 'CAROUSEL', children: children.join(','), caption: post.caption };
          break;
        }
        default:
          throw new InstagramError(`Unsupported media type ${post.mediaType}`);
      }

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
    async quota() {
      return { used: null, total: null };
    },
    async publish(_post, { onContainer } = {}) {
      await onContainer?.(`dry_container_${randomUUID().slice(0, 8)}`);
      return { id: `dry_${randomUUID().slice(0, 8)}`, permalink: null, dryRun: true };
    },
  };
}
