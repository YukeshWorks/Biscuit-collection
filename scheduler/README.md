# BISCUIT Post Scheduler

A small, **open-source (MIT)**, self-hosted website for scheduling Instagram posts. You upload photos or videos (or paste links), write a caption, pick a time, and the server publishes it **automatically** through Meta's official [Instagram Content Publishing API](https://developers.facebook.com/docs/instagram-platform/content-publishing). No browser automation and no password scraping. It runs on your own server with your own token.

- Schedule **image posts, Reels, carousels (2–10 items) and Stories**
- **Upload from your device** by dragging and dropping or picking files, with a progress bar. PNG/WebP are converted to JPEG in the browser. Or paste public links instead.
- Reorder carousel items. A live Instagram-style preview shows feed posts with swipe dots and Stories in 9:16. Warns you about image shapes Instagram won't accept.
- Caption, hashtag and mention counters (2200 / 30 / 20 limits)
- Queue with Upcoming / Calendar / Published / Failed views. Edit, Duplicate, Publish now, Retry and Delete actions.
- **Month calendar**: click a post to edit it
- **Test connection** shows your @username and how much of the 24-hour publishing limit you've used
- **Dry-run mode** (the default) that simulates publishing so you can test safely
- Password-protected dashboard, HttpOnly session cookie, strict CSP
- **Automatic token renewal** (free), so the 60-day token never lapses
- **Zero dependencies**: just Node.js 22.9+. Data is kept in a JSON file.

**Try it:** there's a [clickable demo](https://claude.ai/artifact/UKqDKghWkDxRBg82uLrXfi) that runs in your browser with sample posts. The link is private by default; share it from the page's Share menu. To rebuild it, run `node demo/build-demo.mjs out.html`. It bundles the dashboard with an in-browser fake backend (`demo/demo-shim.js`), so nothing is sent to Instagram.

## Free option: run it on GitHub (no server)

This repository can publish your posts on its own, using GitHub Actions on GitHub's servers. It's free for public repositories. You queue a post by opening an issue, and you can do that from the GitHub app on your phone.

**Step 1: queue a post.** Open the [Instagram post form](https://github.com/YukeshWorks/Biscuit-collection/issues/new?template=instagram-post.yml). Choose Feed or Story, type the time (e.g. `2026-11-20 18:30`, or `now`), drag in JPEG photos or MP4/MOV videos, write the caption, and press **Create**.

**What happens next:**
- Within a minute the bot comments to confirm the scheduled time, or explains anything it needs you to fix.
- It checks every 15 minutes. At your time it publishes, comments the Instagram link and closes the issue. GitHub can delay scheduled runs by a few minutes when it's busy.
- 1 video makes a Reel, 2–10 items make a carousel, and a Story takes exactly 1 item.
- If something fails, the issue gets a **failed** label and a comment saying why. Remove the label to try again.
- Only issues opened by the owner or collaborators are published. Issues from anyone else are ignored, because the repository is public.

**Step 2: connect Instagram (one time).** In the repository, go to **Settings → Secrets and variables → Actions**.
- *Secrets:* add `IG_USER_ID` and `IG_ACCESS_TOKEN` (see "Going live" below for how to get them).
- *Variables (optional):* `IG_TIMEZONE`, e.g. `Asia/Kolkata`, so you can type times in your own time zone. `IG_GRAPH_HOST` defaults to `graph.instagram.com`; set it to `graph.facebook.com` for a Facebook Login token.

Until the secrets are set, it runs in **dry run**: it checks each post and comments, but publishes nothing.

**Token renewal:** with an Instagram Login token, the workflow renews it automatically. It stores the renewed token encrypted in the `instagram-state` branch, with a key derived from your secret, so the public branch never contains a readable token.

**Why some formats are refused:** Instagram's API only accepts JPEG photos, so PNG, HEIC and WebP files get a comment explaining how to export them as JPEG. GitHub attachments are limited to 10 MB for images and 100 MB for videos.

The workflow is `.github/workflows/instagram-scheduler.yml`, the form is `.github/ISSUE_TEMPLATE/instagram-post.yml`, and the code is `github/run.mjs` and `lib/github-runner.js`.

## Self-hosted dashboard

## Quick start

```bash
cd scheduler
cp .env.example .env      # then set ADMIN_PASSWORD
npm start                 # http://127.0.0.1:8787
```

It starts in **DRY RUN** mode: posts are marked "published" but nothing is sent to Instagram.

```bash
npm test
```

## Going live

Requirements (set by Meta, not by this app):

1. An Instagram **Business or Creator** account. Personal accounts can't use the publishing API.
2. A Meta developer app at <https://developers.facebook.com/apps> with the Instagram API product added.
3. An access token with publishing permission:
   - *Instagram API with Instagram Login*: `instagram_business_basic`, `instagram_business_content_publish`. Set `IG_GRAPH_HOST=graph.instagram.com`.
   - *Instagram API with Facebook Login* (account linked to a Facebook Page): `instagram_basic`, `instagram_content_publish`, `pages_read_engagement`. Use `IG_GRAPH_HOST=graph.facebook.com`.
4. Your Instagram professional account **user ID** (`IG_USER_ID`).

Then in `.env`:

```ini
DRY_RUN=false
IG_USER_ID=1784...
IG_ACCESS_TOKEN=...      # long-lived token; never commit this
```

Restart, and click **Test connection**. It should show your @username.

### Token renewal (free, automatic)

Long-lived tokens last 60 days. Renewing them costs nothing.

- **Instagram Login (`IG_GRAPH_HOST=graph.instagram.com`): renewed automatically.** The server checks every hour and renews once fewer than 50 days are left, so roughly every 10 days. It calls Meta's free `refresh_access_token` endpoint. The new token is saved to `DATA_DIR/token.json` (file mode 600) so it survives restarts. The dashboard shows the expiry date and has a **Renew now** button. If a renewal fails, you see a warning there and it retries daily. If you paste a different token into `.env`, that one takes over.
- **Facebook Login (`graph.facebook.com`):** Meta doesn't offer a renew call for these tokens. Instead, create a **System User** token in Meta Business Settings with "Never" as the expiry. Or swap in a new token before the 60 days are up. The dashboard reminds you that auto-renew is off.

Keep the server running at least once every 60 days. An already-expired token can't be renewed, and you'd need to generate a new one.

### Things Instagram requires

- **Instagram downloads the media from a public `https://` URL.** Pasted links must be public. **Uploaded** files are served by this app at `<PUBLIC_URL>/media/<random-name>`, so in live mode `PUBLIC_URL` must be this server's public https address. The Docker setup below gives you that. Upload names are 128-bit random, and files are deleted when their post is deleted.
- Images: JPEG, feed aspect ratio 4:5 to 1.91:1 (the dashboard warns you). Videos: MP4/MOV (H.264/AAC). Reels are up to 15 minutes.
- Stories: the API publishes the image or video only. Captions, stickers and links aren't available for Stories through the API.
- Instagram enforces a rolling **publishing limit per 24 hours** per account. **Test connection** shows your current usage.
- Not supported: shopping tags, collaborators, location tags, Reel cover images. These are possible additions.

## How it works

```
every 30s → find posts with status=scheduled and publishAt ≤ now
  → (carousel) POST /{ig-user-id}/media is_carousel_item=true   once per item
  → POST /{ig-user-id}/media           (create container: IMAGE | REELS | STORIES | CAROUSEL)
  → GET  /{container-id}?fields=status_code   until FINISHED
  → POST /{ig-user-id}/media_publish   (goes live)
  → save media id + permalink
```

If the server is killed **mid-publish**, the post is marked *failed* with "Interrupted…" instead of being retried automatically, because it may already be live and a retry could post it twice. Check Instagram before you click Retry.

## Deploying

The app must stay running for scheduled posts to go out, so static hosting (GitHub Pages, Netlify) won't work. Any small always-on machine works: a VPS, Oracle Cloud's free tier, or a Raspberry Pi.

### Option A: Docker with automatic HTTPS (recommended)

You need a domain (or subdomain) pointing at your server, with ports 80 and 443 open.

```bash
cd scheduler
cp .env.example .env
# edit .env: ADMIN_PASSWORD, DOMAIN=posts.example.com, PUBLIC_URL=https://posts.example.com,
#            DRY_RUN=false, IG_USER_ID, IG_ACCESS_TOKEN
docker compose up -d --build
```

Caddy gets a free Let's Encrypt certificate and forwards traffic to the app. Posts, uploads and the renewed token live in the `scheduler-data` volume.

### Option B: systemd + your own reverse proxy

Use `biscuit-scheduler.service` (instructions are inside the file). Put Caddy or nginx in front of it with HTTPS, and set `COOKIE_SECURE=true`, `TRUST_PROXY=true` and `PUBLIC_URL=https://…`. Allow request bodies as large as `MAX_VIDEO_MB`.

**Back up `DATA_DIR/`**: `posts.json`, `media/`, and `token.json`. The token file holds your renewed token, so treat it like a password.

## Layout

```
server.js          HTTP server, auth, REST API
lib/instagram.js   Graph API client (+ dry-run client)
lib/scheduler.js   due-post loop, crash recovery
lib/token.js       automatic access-token renewal
lib/media.js       uploads: type sniffing, size limits, public serving with ranges
lib/issue-post.js  GitHub issue form parsing, time zones, media checks
lib/github-runner.js  publishes issue-queued posts from GitHub Actions
github/run.mjs     workflow entry point
lib/store.js       atomic JSON-file storage
lib/validate.js    input + Instagram limit checks
public/            dashboard (vanilla HTML/CSS/JS)
demo/              single-file browser demo builder + fake backend
test/              node:test suite
Dockerfile, docker-compose.yml, Caddyfile, biscuit-scheduler.service   deployment
```

## License

MIT. See [LICENSE](LICENSE).
