# BISCUIT Post Scheduler

A small, **open-source (MIT)**, self-hosted website for scheduling Instagram posts. You write a caption, paste a public image or video link, pick a time, and the server publishes it **automatically** through Meta's official [Instagram Content Publishing API](https://developers.facebook.com/docs/instagram-platform/content-publishing). No browser automation and no password scraping. It runs on your own server with your own token.

- Schedule **image posts** and **Reels**
- Live Instagram-style preview, plus caption, hashtag and mention counters (2200 / 30 / 20 limits)
- Queue with Upcoming / Published / Failed tabs, plus Publish now, Retry and Delete actions
- **Dry-run mode** (the default) that simulates publishing so you can test safely
- Password-protected dashboard, HttpOnly session cookie, strict CSP
- **Zero dependencies**: just Node.js 22.9+. Data is kept in a JSON file.

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

> Long-lived tokens expire after about 60 days. Refresh them before then, or publishing will start failing with an auth error, which shows up in the Failed tab.

### Things Instagram requires

- **Media must be at a public `https://` URL.** Instagram's servers download it. Use any public host or bucket (S3/R2/Cloudinary/GitHub Pages…). Images: JPEG, aspect ratio 4:5 to 1.91:1. Reels: MP4/H.264.
- Instagram enforces a rolling **publishing limit per 24 hours** per account (see Meta's docs for the current number).
- Stories, carousels and shopping tags aren't supported in this version.

## How it works

```
every 30s → find posts with status=scheduled and publishAt ≤ now
  → POST /{ig-user-id}/media           (create container)
  → GET  /{container-id}?fields=status_code   until FINISHED
  → POST /{ig-user-id}/media_publish   (goes live)
  → save media id + permalink
```

If the server is killed **mid-publish**, the post is marked *failed* with "Interrupted…" instead of being retried automatically, because it may already be live and a retry could post it twice. Check Instagram before you click Retry.

## Deploying

The app must stay running for the scheduler to fire, so a static host won't work. Any small always-on box works: a VPS, Raspberry Pi, Fly.io, Railway or Render. Run `npm start` under systemd, pm2 or Docker. Put it behind an HTTPS reverse proxy (Caddy or nginx) and set `COOKIE_SECURE=true`. Keep `HOST=127.0.0.1` when the proxy is on the same machine. Back up `DATA_DIR/posts.json`.

## Layout

```
server.js          HTTP server, auth, REST API
lib/instagram.js   Graph API client (+ dry-run client)
lib/scheduler.js   due-post loop, crash recovery
lib/store.js       atomic JSON-file storage
lib/validate.js    input + Instagram limit checks
public/            dashboard (vanilla HTML/CSS/JS)
test/              node:test suite
```

## License

MIT. See [LICENSE](LICENSE).
