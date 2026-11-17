// Entry point for .github/workflows/instagram-scheduler.yml.
import { createInstagramClient } from '../lib/instagram.js';
import { createTokenManager } from '../lib/token.js';
import { createGitHubApi, runQueue } from '../lib/github-runner.js';

const env = process.env;
const need = (k) => {
  if (!env[k]) throw new Error(`${k} is not set`);
  return env[k];
};

const github = createGitHubApi({ repo: need('GITHUB_REPOSITORY'), token: need('GITHUB_TOKEN') });
const dryRun = !(env.IG_USER_ID && env.IG_ACCESS_TOKEN);
const host = env.IG_GRAPH_HOST || 'graph.instagram.com';

let client = null;
if (!dryRun) {
  client = createInstagramClient({ userId: env.IG_USER_ID, accessToken: env.IG_ACCESS_TOKEN, host, version: env.IG_API_VERSION || 'v23.0' });
  const tokens = await createTokenManager({
    envToken: env.IG_ACCESS_TOKEN,
    host,
    dataDir: need('STATE_DIR'),
    encrypt: true, // the state branch is public; the renewed token is stored encrypted
    onToken: (t) => client.setAccessToken(t),
  });
  await tokens.check();
  const t = tokens.status();
  console.log(t.autoRenew
    ? `Token: renews automatically${t.expiresAt ? `, valid until ${t.expiresAt}` : ''}${t.lastError ? ` (last renewal failed: ${t.lastError})` : ''}`
    : 'Token: auto-renew is off for this host; use a token that never expires.');
}

console.log(dryRun ? 'Mode: DRY RUN (IG_USER_ID / IG_ACCESS_TOKEN secrets not set)' : `Mode: LIVE via ${host}`);
const summary = await runQueue({ github, client, dryRun, defaultTimeZone: env.IG_TIMEZONE || 'UTC' });
console.log('Summary:', JSON.stringify(summary));
if (summary.failed) process.exitCode = 1; // make failures visible in the Actions tab
