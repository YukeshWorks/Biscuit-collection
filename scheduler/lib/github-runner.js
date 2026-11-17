// Publishes Instagram posts described by GitHub issues (see .github/ISSUE_TEMPLATE/instagram-post.yml).
// Runs inside GitHub Actions on a schedule; GitHub's servers do the work, so no host is needed.
//
// Issue lifecycle (labels):
//   instagram        -> queued (added by the issue form)
//   publishing       -> a run is publishing it right now
//   failed           -> publishing failed; remove this label to try again
//   dry-run-ok       -> checked in dry run (no Instagram credentials yet); stays open for when you go live
//   published        -> done; the issue is closed with the Instagram link
import { createHash } from 'node:crypto';
import { parseIssueForm, parseWhen, extractUrls, resolveMedia, placementFrom, isValidTimeZone } from './issue-post.js';
import { validatePost } from './validate.js';

const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const L = { queue: 'instagram', publishing: 'publishing', failed: 'failed', dry: 'dry-run-ok', done: 'published' };

export function createGitHubApi({ repo, token, fetchImpl = globalThis.fetch }) {
  async function gh(method, path, body) {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'biscuit-post-scheduler',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok && !(method === 'DELETE' && res.status === 404)) throw new Error(`GitHub API ${method} ${path}: ${res.status} ${data.message ?? ''}`);
    return data;
  }
  return {
    async openQueuedIssues() {
      const out = [];
      for (let page = 1; page <= 10; page++) {
        const batch = await gh('GET', `/issues?state=open&labels=${L.queue}&per_page=100&page=${page}`);
        out.push(...batch.filter((i) => !i.pull_request));
        if (batch.length < 100) break;
      }
      return out;
    },
    comments: (n) => gh('GET', `/issues/${n}/comments?per_page=100`),
    comment: (n, body) => gh('POST', `/issues/${n}/comments`, { body }),
    addLabels: (n, labels) => gh('POST', `/issues/${n}/labels`, { labels }),
    removeLabel: (n, label) => gh('DELETE', `/issues/${n}/labels/${encodeURIComponent(label)}`),
    close: (n) => gh('PATCH', `/issues/${n}`, { state: 'closed', state_reason: 'completed' }),
  };
}

const hash = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
const marker = (kind, h) => `<!-- biscuit:${kind}:${h} -->`;

function fmtTime(ts, timeZone) {
  const local = new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ts));
  return `${local} (${timeZone})`;
}

// Build a validated post from an issue, without touching the network.
export function postFromIssue(issue, { defaultTimeZone = 'UTC', now = Date.now() } = {}) {
  const f = parseIssueForm(issue.body);
  const errors = [];
  const timeZone = f.timezone?.trim() || defaultTimeZone;
  if (!isValidTimeZone(timeZone)) errors.push(`"${timeZone}" isn’t a time zone I know. Use a name like Asia/Kolkata or Europe/London.`);
  const when = parseWhen(f.when, isValidTimeZone(timeZone) ? timeZone : 'UTC', now);
  if (when.error) errors.push(when.error);
  const urls = extractUrls(f.media);
  if (!urls.length) errors.push('Add at least one photo or video: drag it into the “Photos or videos” box.');
  const placement = placementFrom(f.placement);
  const draft = {
    placement,
    media: urls.map((url) => ({ url })),
    caption: f.caption ?? '',
    publishAt: new Date(when.ts ?? now).toISOString(),
  };
  // Due posts are in the past by definition; validate limits, not "is it in the future".
  const v = validatePost(draft, { now: when.ts ?? now });
  if (urls.length) errors.push(...v.errors.filter((e) => !/publishAt/.test(e)));
  return { ok: errors.length === 0, errors, post: v.value, ts: when.ts ?? null, timeZone };
}

export async function runQueue({ github, client, dryRun, defaultTimeZone = 'UTC', now = () => Date.now(), fetchImpl = globalThis.fetch, log = console }) {
  const summary = { published: 0, failed: 0, waiting: 0, invalid: 0, skipped: 0, dry: 0 };
  const issues = await github.openQueuedIssues();

  for (const issue of issues) {
    const n = issue.number;
    const labels = new Set(issue.labels.map((l) => (typeof l === 'string' ? l : l.name)));

    if (!TRUSTED.has(issue.author_association)) {
      summary.skipped++;
      log.info?.(`#${n}: skipped, opened by @${issue.user?.login} (${issue.author_association}), who isn’t the owner or a collaborator`);
      continue;
    }

    if (labels.has(L.publishing)) {
      // A previous run stopped mid-publish. It may already be live: don't retry blindly.
      await github.removeLabel(n, L.publishing);
      await github.addLabels(n, [L.failed]);
      await github.comment(n, '⚠️ The last run stopped while publishing this post, so it may or may not be on Instagram. Check your profile. If it isn’t there, remove the **failed** label to try again.');
      summary.failed++;
      continue;
    }
    if (labels.has(L.failed)) { summary.skipped++; continue; }

    const bodyHash = hash(issue.body);
    const parsed = postFromIssue(issue, { defaultTimeZone, now: now() });
    const comments = await github.comments(n);
    const said = (kind) => comments.some((c) => c.body?.includes(marker(kind, bodyHash)));

    if (!parsed.ok) {
      summary.invalid++;
      if (!said('invalid')) {
        await github.comment(n, `${marker('invalid', bodyHash)}❌ I can’t schedule this yet:\n\n${parsed.errors.map((e) => `- ${e}`).join('\n')}\n\nEdit the issue to fix it and I’ll check again.`);
      }
      continue;
    }

    if (parsed.ts > now()) {
      summary.waiting++;
      if (!said('scheduled')) {
        const type = { IMAGE: 'Photo post', REELS: 'Reel', CAROUSEL: `Carousel (${parsed.post.media.length})`, STORIES: 'Story' }[parsed.post.mediaType];
        await github.comment(n, `${marker('scheduled', bodyHash)}📅 Scheduled: **${type}** for **${fmtTime(parsed.ts, parsed.timeZone)}**.${dryRun ? '\n\n🧪 Instagram isn’t connected yet (dry run), so I’ll only check it at that time. Add the `IG_USER_ID` and `IG_ACCESS_TOKEN` secrets to publish for real.' : ''}\n\nThe scheduler checks every 15 minutes, so it may go out a few minutes after that time.`);
      }
      continue;
    }

    if (dryRun && labels.has(L.dry)) { summary.dry++; continue; }

    // Due: resolve and check every file first.
    const media = [];
    const problems = [];
    for (const [i, m] of parsed.post.media.entries()) {
      const r = await resolveMedia(m.url, fetchImpl);
      if (r.error) problems.push(`Item ${i + 1} ${r.error}`);
      else media.push(r);
    }
    const post = { ...parsed.post, media };
    if (!problems.length) {
      const v = validatePost({ ...post, publishAt: new Date(now()).toISOString() }, { now: now() });
      problems.push(...v.errors);
      post.mediaType = v.value.mediaType;
    }
    if (problems.length) {
      summary.invalid++;
      if (!said('media')) await github.comment(n, `${marker('media', bodyHash)}❌ I couldn’t use the media:\n\n${problems.map((e) => `- ${e}`).join('\n')}\n\nEdit the issue to fix it and I’ll try again.`);
      continue;
    }

    if (dryRun) {
      await github.addLabels(n, [L.dry]);
      await github.comment(n, `🧪 Dry run: this **${post.mediaType.toLowerCase()}** is valid and would have been published now. Add the \`IG_USER_ID\` and \`IG_ACCESS_TOKEN\` repository secrets to publish for real; it stays open until then.`);
      summary.dry++;
      continue;
    }

    await github.addLabels(n, [L.publishing]);
    try {
      const result = await client.publish(post);
      await github.comment(n, `✅ Published to Instagram${result.permalink ? `: ${result.permalink}` : ` (media id ${result.id})`}`);
      await github.removeLabel(n, L.publishing);
      await github.addLabels(n, [L.done]);
      await github.close(n);
      summary.published++;
      log.info?.(`#${n}: published ${result.id}`);
    } catch (err) {
      await github.removeLabel(n, L.publishing);
      await github.addLabels(n, [L.failed]);
      await github.comment(n, `❌ Instagram refused this post: ${String(err.message).slice(0, 500)}\n\nFix the problem (edit the issue if needed), then remove the **failed** label to try again.`);
      summary.failed++;
      log.warn?.(`#${n}: failed: ${err.message}`);
    }
  }
  return summary;
}
