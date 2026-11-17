// In-browser stand-in for server.js, used only by the single-file demo build.
// It answers the dashboard's /api calls from memory, keeps state in localStorage when
// available, simulates uploads and dry-run publishing, and never contacts Instagram.
(() => {
  const KEY = 'biscuit-demo-v1';
  const H = 3600e3;
  const D = 24 * H;
  const media = {}; // file name -> data: or blob: URL
  let posts = [];
  let authenticated = true;
  let tokenExpiresAt = new Date(Date.now() + 52 * D).toISOString();

  const hex = (n = 32) => Array.from(crypto.getRandomValues(new Uint8Array(n / 2)), (b) => b.toString(16).padStart(2, '0')).join('');
  const iso = (ms) => new Date(ms).toISOString();

  function save() {
    try {
      const keep = {};
      for (const [k, v] of Object.entries(media)) if (v.startsWith('data:')) keep[k] = v;
      localStorage.setItem(KEY, JSON.stringify({ posts, media: keep, tokenExpiresAt }));
    } catch { /* storage full or blocked: demo still works for this visit */ }
  }

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (saved && Array.isArray(saved.posts)) {
        posts = saved.posts;
        Object.assign(media, saved.media || {});
        tokenExpiresAt = saved.tokenExpiresAt || tokenExpiresAt;
        return true;
      }
    } catch { /* fall through to seed */ }
    return false;
  }

  // Sample artwork, drawn on a canvas so the page ships no image files.
  function art(hue, label, shape, w = 540, h = 675) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, w * 0.6, h);
    grad.addColorStop(0, `hsl(${hue} 72% 76%)`);
    grad.addColorStop(1, `hsl(${(hue + 55) % 360} 58% 42%)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,.75)';
    for (let i = 0; i < 40; i++) {
      const x = (Math.sin(i * 91.7 + hue) * 0.5 + 0.5) * w;
      const y = (Math.cos(i * 37.3 + hue) * 0.5 + 0.5) * h * 0.55;
      g.beginPath(); g.arc(x, y, (i % 3) + 0.8, 0, 7); g.fill();
    }
    g.fillStyle = 'rgba(255,255,255,.55)';
    g.beginPath();
    if (shape === 'moon') { g.arc(w * 0.62, h * 0.32, w * 0.16, 0, 7); g.fill(); g.fillStyle = `hsl(${hue} 70% 70%)`; g.beginPath(); g.arc(w * 0.68, h * 0.29, w * 0.15, 0, 7); }
    else if (shape === 'hills') { g.moveTo(0, h * 0.75); g.quadraticCurveTo(w * 0.3, h * 0.55, w * 0.6, h * 0.72); g.quadraticCurveTo(w * 0.85, h * 0.85, w, h * 0.68); g.lineTo(w, h); g.lineTo(0, h); }
    else { g.arc(w / 2, h * 0.42, w * 0.24, 0, 7); }
    g.fill();
    g.fillStyle = 'rgba(20,12,34,.88)';
    g.font = `700 ${Math.round(w / 11)}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.fillText(label, w / 2, h * 0.9);
    const file = `${hex()}.jpg`;
    media[file] = c.toDataURL('image/jpeg', 0.82);
    return { kind: 'image', file };
  }

  function post(fields) {
    const now = Date.now();
    return {
      id: crypto.randomUUID(), placement: 'FEED', caption: '', status: 'scheduled', attempts: 0,
      containerId: null, igMediaId: null, permalink: null, error: null, publishedAt: null,
      createdAt: iso(now), updatedAt: iso(now), ...fields,
    };
  }

  function seed() {
    const now = Date.now();
    const at = (ms, hour) => { const d = new Date(now + ms); d.setHours(hour, 0, 0, 0); return d.getTime(); };
    posts = [
      post({ mediaType: 'IMAGE', media: [art(265, 'MOONLIT', 'moon')], caption: 'Pastel night sky wallpaper, free for personal use ✨\n#biscuitart #wallpaper #pastelart', publishAt: iso(at(-2 * D, 18)), status: 'published', publishedAt: iso(at(-2 * D, 18)), dryRun: true, igMediaId: 'demo_1' }),
      post({ mediaType: 'CAROUSEL', media: [art(330, 'PAGE 1', 'sun'), art(20, 'PAGE 2', 'hills'), art(190, 'PAGE 3', 'moon')], caption: 'Sketchbook pages from this week. Which one should become a print? 🎨', publishAt: iso(at(-1 * D, 19)), status: 'published', publishedAt: iso(at(-1 * D, 19)), dryRun: true, igMediaId: 'demo_2' }),
      post({ mediaType: 'IMAGE', media: [{ kind: 'image', url: 'https://example.com/missing-artwork.jpg' }], caption: 'Process timelapse still', publishAt: iso(at(-1 * D, 9)), status: 'failed', error: 'Instagram couldn’t download the media (HTTP 404). Check that the link is public, then edit or retry.', attempts: 1 }),
      post({ mediaType: 'CAROUSEL', media: [art(210, 'DUSK', 'hills'), art(285, 'NIGHT', 'moon'), art(35, 'DAWN', 'sun')], caption: 'Sky triptych drop 🌙 swipe for all three, wallpapers in my bio link\n#biscuitart #triptych', publishAt: iso(Math.max(now + 3 * H, at(0, 20))) }),
      post({ placement: 'STORY', mediaType: 'STORIES', media: [art(300, 'NEW DROP', 'sun', 540, 960)], publishAt: iso(at(1 * D, 12)) }),
      post({ mediaType: 'IMAGE', media: [art(150, 'COMMISSIONS', 'hills')], caption: 'Commission slots are open for December! 3 spots. DM me 💌\n#commissionsopen #biscuitart', publishAt: iso(at(3 * D, 17)) }),
      post({ mediaType: 'IMAGE', media: [art(45, 'GOLDEN', 'sun')], caption: 'Golden hour study', publishAt: iso(at(6 * D, 18)) }),
    ];
    save();
  }

  if (!load()) seed();

  window.BISCUIT_MEDIA_URL = (file) => media[file] ?? null;

  // ---- validation (mirrors lib/validate.js) ----
  function validate(input) {
    const errors = [];
    const placement = String(input.placement || 'FEED').toUpperCase();
    const list = Array.isArray(input.media) ? input.media : [];
    if (!list.length) errors.push('Add at least one image or video.');
    if (placement === 'STORY' && list.length > 1) errors.push('A story takes exactly one image or video.');
    if (list.length > 10) errors.push('A carousel can have at most 10 items.');
    for (const [i, m] of list.entries()) if (!m.file && !/^https:\/\//.test(m.url || '')) errors.push(`Media ${i + 1}: link must be a public https:// URL.`);
    const caption = placement === 'STORY' ? '' : String(input.caption || '');
    if (caption.length > 2200) errors.push('Caption is over 2200 characters.');
    if ((caption.match(/#[\p{L}\p{N}_]+/gu) || []).length > 30) errors.push('Caption has more than 30 hashtags.');
    if ((caption.match(/(^|\s)@[\w.]+/g) || []).length > 20) errors.push('Caption has more than 20 @mentions.');
    const t = Date.parse(input.publishAt);
    if (Number.isNaN(t)) errors.push('publishAt must be a valid date/time.');
    else if (t < Date.now() - 60e3) errors.push('publishAt is in the past.');
    const mediaType = placement === 'STORY' ? 'STORIES' : list.length > 1 ? 'CAROUSEL' : list[0]?.kind === 'video' ? 'REELS' : 'IMAGE';
    return { errors, value: { placement, media: list, caption, mediaType, publishAt: Number.isNaN(t) ? null : iso(t) } };
  }

  // ---- dry-run scheduler ----
  function tick() {
    let changed = false;
    for (const p of posts) {
      if (p.status === 'scheduled' && Date.parse(p.publishAt) <= Date.now()) {
        p.status = 'publishing';
        changed = true;
        setTimeout(() => {
          Object.assign(p, { status: 'published', dryRun: true, igMediaId: `demo_${hex(8)}`, publishedAt: iso(Date.now()), updatedAt: iso(Date.now()) });
          save();
        }, 1500);
      }
    }
    if (changed) save();
  }
  setInterval(tick, 2000);

  // ---- fake API ----
  const json = (status, body) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  async function handle(method, path, body) {
    if (path === '/api/session') return json(200, { authenticated });
    if (path === '/api/login') { authenticated = true; return json(200, { ok: true }); }
    if (!authenticated) return json(401, { error: 'Log in first.' });
    if (path === '/api/logout') { authenticated = false; return json(200, { ok: true }); }
    if (path === '/api/status') {
      return json(200, { dryRun: true, apiVersion: 'v23.0', uploadsReady: true, maxVideoMb: 300,
        token: { autoRenew: true, expiresAt: tokenExpiresAt, refreshedAt: iso(Date.now() - 8 * D), lastError: null } });
    }
    if (path === '/api/check') {
      const used = posts.filter((p) => p.publishedAt && Date.now() - Date.parse(p.publishedAt) < D).length;
      return json(200, { ok: true, account: { username: 'biscuit.art (demo)' }, quota: { used, total: 100 } });
    }
    if (path === '/api/token/renew') {
      tokenExpiresAt = iso(Date.now() + 60 * D);
      save();
      return json(200, { token: { autoRenew: true, expiresAt: tokenExpiresAt, refreshedAt: iso(Date.now()), lastError: null } });
    }
    if (path === '/api/posts' && method === 'GET') {
      return json(200, { posts: structuredClone(posts).sort((a, b) => Date.parse(a.publishAt) - Date.parse(b.publishAt)) });
    }
    if (path === '/api/posts' && method === 'POST') {
      const { errors, value } = validate(body);
      if (errors.length) return json(422, { error: errors.join(' ') });
      const p = post(value);
      posts.push(p);
      save();
      tick();
      return json(201, { post: p });
    }
    const m = /^\/api\/posts\/([\w-]+)(?:\/(retry|publish-now))?$/.exec(path);
    if (m) {
      const p = posts.find((x) => x.id === m[1]);
      if (!p) return json(404, { error: 'Post not found.' });
      const action = m[2];
      if (!action && method === 'DELETE') {
        posts = posts.filter((x) => x !== p);
        save();
        return json(204);
      }
      if (!action && method === 'PATCH') {
        if (!['scheduled', 'failed'].includes(p.status)) return json(409, { error: 'Only scheduled or failed posts can be edited.' });
        const { errors, value } = validate({ ...p, ...body });
        if (errors.length) return json(422, { error: errors.join(' ') });
        Object.assign(p, value, { status: 'scheduled', error: null, updatedAt: iso(Date.now()) });
        save();
        tick();
        return json(200, { post: p });
      }
      if (action === 'retry') {
        if (p.status !== 'failed') return json(409, { error: 'Only failed posts can be retried.' });
        if (p.media.some((x) => x.url?.includes('missing-artwork'))) {
          p.attempts += 1;
          save();
          return json(502, { error: 'Still failing: that link returns 404. Click Edit, remove the link and upload the image instead.' });
        }
        Object.assign(p, { status: 'scheduled', error: null, publishAt: iso(Date.now()) });
        save();
        tick();
        return json(200, { post: p });
      }
      if (action === 'publish-now') {
        if (p.status !== 'scheduled') return json(409, { error: 'Only scheduled posts can be published now.' });
        p.publishAt = iso(Date.now());
        save();
        tick();
        return json(200, { post: p });
      }
    }
    return json(404, { error: 'Not found.' });
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
    let body = {};
    try { body = init.body ? JSON.parse(init.body) : {}; } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 120));
    return handle((init.method || 'GET').toUpperCase(), url.pathname, body);
  };

  // Uploads: the dashboard uses XMLHttpRequest for progress, so stand in for it.
  class DemoXHR {
    constructor() { this.upload = {}; this.status = 0; this.responseText = ''; this.headers = {}; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(k, v) { this.headers[k.toLowerCase()] = v; }
    send(blob) {
      const type = this.headers['content-type'] || blob.type;
      const ext = type === 'image/jpeg' ? 'jpg' : type === 'video/quicktime' ? 'mov' : type === 'video/mp4' ? 'mp4' : null;
      const finish = (status, data) => { this.status = status; this.responseText = JSON.stringify(data); this.onload?.(); };
      if (!ext) { setTimeout(() => finish(415, { error: 'Upload a JPEG image or an MP4/MOV video.' }), 200); return; }
      let p = 0;
      const step = () => {
        p = Math.min(1, p + 0.2);
        this.upload.onprogress?.({ lengthComputable: true, loaded: p * blob.size, total: blob.size });
        if (p < 1) { setTimeout(step, 120); return; }
        const file = `${hex()}.${ext}`;
        const done = (url) => { media[file] = url; finish(201, { file, kind: ext === 'jpg' ? 'image' : 'video', size: blob.size }); };
        if (blob.size < 1.5 * 1024 * 1024) {
          const r = new FileReader();
          r.onload = () => done(r.result);
          r.onerror = () => done(URL.createObjectURL(blob));
          r.readAsDataURL(blob);
        } else {
          done(URL.createObjectURL(blob)); // large files stay for this visit only
        }
      };
      setTimeout(step, 80);
    }
  }
  window.XMLHttpRequest = DemoXHR;

  // Reset button in the demo strip.
  window.BISCUIT_DEMO_RESET = () => {
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
    for (const k of Object.keys(media)) delete media[k];
    seed();
    location.reload();
  };
})();
