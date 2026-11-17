const $ = (s, root = document) => root.querySelector(s);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
};

const state = {
  posts: [],
  filter: 'upcoming',
  refreshTimer: null,
  status: {},
  calMonth: startOfMonth(new Date()),
  compose: { media: [], editingId: null, slide: 0 },
};

/* ---------- api ---------- */
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') showLogin();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// XHR for upload progress (fetch can't report it).
function uploadBlob(blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/uploads');
    xhr.setRequestHeader('content-type', blob.type);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status === 401) showLogin();
      xhr.status < 300 ? resolve(data) : reject(new Error(data.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed: network error.'));
    xhr.send(blob);
  });
}

// In-page confirmation, because native confirm dialogs are blocked in some embedded views.
function askConfirm(text, yesLabel = 'Confirm') {
  const box = $('#confirm');
  $('#confirm-text').textContent = text;
  $('#confirm-yes').textContent = yesLabel;
  box.hidden = false;
  $('#confirm-yes').focus();
  return new Promise((resolve) => {
    const done = (answer) => {
      box.hidden = true;
      $('#confirm-yes').onclick = $('#confirm-no').onclick = box.onclick = box.onkeydown = null;
      resolve(answer);
    };
    $('#confirm-yes').onclick = () => done(true);
    $('#confirm-no').onclick = () => done(false);
    box.onclick = (e) => { if (e.target === box) done(false); };
    box.onkeydown = (e) => { if (e.key === 'Escape') done(false); };
  });
}

function banner(text, bad = false) {
  const b = $('#banner');
  b.textContent = text;
  b.classList.toggle('bad', bad);
  b.hidden = !text;
  clearTimeout(banner.t);
  if (text) banner.t = setTimeout(() => (b.hidden = true), 8000);
}

/* ---------- views ---------- */
function showLogin() {
  clearInterval(state.refreshTimer);
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
}

async function showApp() {
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  const status = (state.status = await api('/api/status'));
  const pill = $('#mode-pill');
  pill.textContent = status.dryRun ? 'Dry run' : 'Live';
  pill.className = `pill ${status.dryRun ? 'dry' : 'live'}`;
  pill.title = status.dryRun ? 'Nothing is sent to Instagram. Set DRY_RUN=false with your credentials to go live.' : `Publishing via Graph API ${status.apiVersion}`;
  const warn = $('#upload-warning');
  warn.hidden = status.uploadsReady;
  warn.textContent = 'Live mode: uploaded files need PUBLIC_URL set to this server’s https:// address so Instagram can download them. Until then, paste public links instead.';
  renderToken(status.token);
  resetCompose();
  await loadPosts();
  clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(loadPosts, 15000);
}

/* ---------- token ---------- */
const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
function renderToken(token) {
  const box = $('#token-note');
  box.hidden = !token;
  if (!token) return;
  const days = token.expiresAt ? Math.floor((Date.parse(token.expiresAt) - Date.now()) / 86400000) : null;
  let text;
  let level = '';
  if (!token.autoRenew) {
    text = 'Token auto-renew is off (it only works with IG_GRAPH_HOST=graph.instagram.com). Use a token that never expires, or replace it before it expires. See the README.';
    level = 'warn';
  } else if (token.lastError) {
    text = `Couldn’t renew the token: ${token.lastError}. It will retry daily.${days !== null ? ` ${days} days left.` : ''}`;
    level = days !== null && days < 7 ? 'bad' : 'warn';
  } else if (days !== null) {
    text = `🔄 Token renews automatically. Valid until ${dateFmt.format(new Date(token.expiresAt))} (${days} days).`;
  } else {
    text = '🔄 Token renews automatically. First renewal pending (tokens must be at least 24h old).';
  }
  $('#token-text').textContent = text;
  box.className = `token-note ${level}`;
  $('#renew-btn').hidden = !token.autoRenew;
}

/* ---------- compose: helpers ---------- */
function toLocalInput(date) {
  const off = date.getTimezoneOffset() * 60000;
  return new Date(date - off).toISOString().slice(0, 16);
}
const form = () => $('#post-form');
const placement = () => form().placement.value;
const readyMedia = () => state.compose.media.filter((m) => m.status === 'ready');
// Where an uploaded file is served from. The in-browser demo overrides this hook.
const mediaPath = (file) => window.BISCUIT_MEDIA_URL?.(file) ?? `/media/${file}`;
const mediaSrc = (m) => m.blobUrl || (m.file ? mediaPath(m.file) : m.url);

function derivedType() {
  const media = state.compose.media;
  if (placement() === 'STORY') return 'Story';
  if (media.length > 1) return `Carousel (${media.length})`;
  return media[0]?.kind === 'video' ? 'Reel' : 'Image post';
}

function resetCompose() {
  for (const m of state.compose.media) if (m.blobUrl) URL.revokeObjectURL(m.blobUrl);
  state.compose = { media: [], editingId: null, slide: 0 };
  form().reset();
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setMinutes(0, 0, 0);
  form().publishAt.value = toLocalInput(d);
  $('#tz-note').textContent = `Your time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
  $('#form-error').textContent = '';
  $('#compose-title').textContent = 'New post';
  $('#submit-btn').textContent = 'Schedule post';
  $('#cancel-edit-btn').hidden = true;
  renderCompose();
}

function loadIntoCompose(post, { editing }) {
  resetCompose();
  state.compose.editingId = editing ? post.id : null;
  state.compose.media = post.media.map((m) => ({ ...m, id: crypto.randomUUID(), status: 'ready' }));
  form().placement.value = post.placement || 'FEED';
  form().caption.value = post.caption || '';
  const when = new Date(post.publishAt);
  form().publishAt.value = toLocalInput(editing && when > Date.now() ? when : new Date(Date.now() + 3600000));
  $('#compose-title').textContent = editing ? 'Edit post' : 'Duplicate post';
  $('#submit-btn').textContent = editing ? 'Save changes' : 'Schedule post';
  $('#cancel-edit-btn').hidden = false;
  renderCompose();
  $('.compose').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------- compose: media ---------- */
async function toUploadable(file) {
  if (file.type === 'video/mp4' || file.type === 'video/quicktime') return { blob: file, kind: 'video' };
  if (!file.type.startsWith('image/')) throw new Error(`${file.name}: use an image, MP4 or MOV.`);
  const needsConvert = file.type !== 'image/jpeg' || file.size > 8 * 1024 * 1024;
  if (!needsConvert) return { blob: file, kind: 'image' };
  // Re-encode as JPEG (Instagram's only accepted image format), max 1440px wide like Instagram.
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error(`${file.name}: this browser can’t read that image format. Export it as JPEG first.`); }
  const scale = Math.min(1, 1440 / bitmap.width);
  const canvas = el('canvas', { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
  return { blob, kind: 'image' };
}

async function addFiles(files) {
  $('#form-error').textContent = '';
  for (const file of files) {
    if (state.compose.media.length >= maxItems()) {
      $('#form-error').textContent = placement() === 'STORY' ? 'A story takes one item. Switch to Feed post for a carousel.' : 'A carousel can have at most 10 items.';
      break;
    }
    const item = { id: crypto.randomUUID(), kind: file.type.startsWith('video/') ? 'video' : 'image', status: 'uploading', progress: 0, name: file.name };
    state.compose.media.push(item);
    renderCompose();
    try {
      const { blob, kind } = await toUploadable(file);
      item.kind = kind;
      item.blobUrl = URL.createObjectURL(blob);
      renderCompose();
      const saved = await uploadBlob(blob, (p) => { item.progress = p; renderMediaList(); });
      Object.assign(item, { file: saved.file, kind: saved.kind, status: 'ready' });
    } catch (err) {
      item.status = 'error';
      item.error = err.message;
    }
    renderCompose();
  }
}

function addUrl() {
  const input = $('#url-input');
  const url = input.value.trim();
  $('#form-error').textContent = '';
  if (!/^https:\/\/\S+$/.test(url)) { $('#form-error').textContent = 'Links must start with https://'; return; }
  if (state.compose.media.length >= maxItems()) { $('#form-error').textContent = 'No room for more media.'; return; }
  const kind = /\.(mp4|mov|m4v)(\?|#|$)/i.test(url) ? 'video' : 'image';
  state.compose.media.push({ id: crypto.randomUUID(), kind, url, status: 'ready' });
  input.value = '';
  renderCompose();
}

const maxItems = () => (placement() === 'STORY' ? 1 : 10);

function moveItem(id, dir) {
  const list = state.compose.media;
  const i = list.findIndex((m) => m.id === id);
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  renderCompose();
}

function removeItem(id) {
  const list = state.compose.media;
  const i = list.findIndex((m) => m.id === id);
  if (i < 0) return;
  if (list[i].blobUrl) URL.revokeObjectURL(list[i].blobUrl);
  list.splice(i, 1);
  state.compose.slide = Math.min(state.compose.slide, Math.max(0, list.length - 1));
  $('#form-error').textContent = '';
  renderCompose();
}

/* ---------- compose: render ---------- */
function renderCompose() {
  const story = placement() === 'STORY';
  $('#type-badge').textContent = derivedType();
  $('#caption-field').hidden = story;
  $('#story-note').hidden = !story;
  $('#media-hint').textContent = story ? 'exactly 1 image or video' : '1 image or video, or 2–10 for a carousel';
  $('#dropzone').classList.toggle('full', state.compose.media.length >= maxItems());
  renderMediaList();
  renderPreview();
  updateCounters();
}

function renderMediaList() {
  const list = $('#media-list');
  list.replaceChildren(
    ...state.compose.media.map((m, i) => {
      const thumb = m.kind === 'video'
        ? el('video', { src: mediaSrc(m) || '', muted: true, preload: 'metadata' })
        : el('img', { src: mediaSrc(m) || '', alt: '' });
      thumb.className = 'mthumb';
      thumb.onerror = () => thumb.replaceWith(el('div', { className: 'mthumb ph', textContent: m.kind === 'video' ? 'VIDEO' : 'IMG' }));
      const badge = el('span', { className: 'mnum', textContent: i + 1 });
      const kind = m.kind === 'video' ? el('span', { className: 'mkind', textContent: '▶' }) : null;
      let overlay = null;
      if (m.status === 'uploading') overlay = el('span', { className: 'mprog', textContent: `${Math.round((m.progress || 0) * 100)}%` });
      if (m.status === 'error') overlay = el('span', { className: 'merr', textContent: '!', title: m.error });
      const controls = el('div', { className: 'mctl' },
        el('button', { type: 'button', textContent: '←', title: 'Move earlier', disabled: i === 0, onclick: () => moveItem(m.id, -1) }),
        el('button', { type: 'button', textContent: '→', title: 'Move later', disabled: i === state.compose.media.length - 1, onclick: () => moveItem(m.id, 1) }),
        el('button', { type: 'button', textContent: '✕', title: 'Remove', onclick: () => removeItem(m.id) }),
      );
      const li = el('li', { className: `mitem ${m.status}`, title: m.error || m.name || m.url || '' }, thumb, badge, kind, overlay, controls);
      li.onclick = (e) => { if (!e.target.closest('button')) { state.compose.slide = i; renderPreview(); } };
      return li;
    }),
  );
  const errs = state.compose.media.filter((m) => m.status === 'error');
  if (errs.length) $('#form-error').textContent = errs.map((m) => m.error).join(' ');
}

function renderPreview() {
  const story = placement() === 'STORY';
  const media = state.compose.media;
  const i = Math.min(state.compose.slide, Math.max(0, media.length - 1));
  $('#phone').classList.toggle('story', story);
  const box = $('#preview-media');
  box.replaceChildren();
  const m = media[i];
  $('#ratio-warning').hidden = true;
  if (!m || !mediaSrc(m)) {
    box.append(el('span', { className: 'muted', textContent: 'Preview appears here' }));
  } else if (m.kind === 'video') {
    box.append(el('video', { src: mediaSrc(m), muted: true, loop: true, autoplay: true, playsInline: true }));
  } else {
    const img = el('img', { src: mediaSrc(m), alt: 'Post preview' });
    img.onload = () => checkRatio(img.naturalWidth, img.naturalHeight, story);
    img.onerror = () => box.replaceChildren(el('span', { className: 'muted', textContent: 'Couldn’t load that image' }));
    box.append(img);
  }
  $('#preview-nav').hidden = media.length < 2;
  $('#preview-dots').replaceChildren(...media.map((_, k) => el('span', { className: k === i ? 'dot on' : 'dot' })));
}

function checkRatio(w, h, story) {
  const r = w / h;
  const warn = $('#ratio-warning');
  if (story) { warn.hidden = true; return; }
  if (r < 0.8 - 0.005 || r > 1.91 + 0.005) {
    warn.textContent = `This image is ${w}×${h} (ratio ${r.toFixed(2)}). Instagram feed images must be between 4:5 (0.8) and 1.91:1, or publishing will fail.`;
    warn.hidden = false;
  }
}

function updateCounters() {
  const cap = form().caption.value;
  const tags = (cap.match(/#[\p{L}\p{N}_]+/gu) || []).length;
  const mentions = (cap.match(/(^|\s)@[\w.]+/g) || []).length;
  const set = (id, text, over) => { const n = $(id); n.textContent = text; n.classList.toggle('over', over); };
  set('#c-chars', `${cap.length}/2200`, cap.length > 2200);
  set('#c-tags', `${tags}/30 hashtags`, tags > 30);
  set('#c-mentions', `${mentions}/20 mentions`, mentions > 20);
  $('#preview-caption').hidden = placement() === 'STORY';
  $('#preview-caption span').textContent = cap;
}

async function submitPost(e) {
  e.preventDefault();
  const f = form();
  const btn = $('#submit-btn');
  $('#form-error').textContent = '';
  if (state.compose.media.some((m) => m.status === 'uploading')) { $('#form-error').textContent = 'Wait for uploads to finish.'; return; }
  if (state.compose.media.some((m) => m.status === 'error')) { $('#form-error').textContent = 'Remove the media that failed to upload.'; return; }
  if (!f.publishAt.value) { $('#form-error').textContent = 'Pick a date and time.'; return; }
  const body = {
    placement: placement(),
    media: readyMedia().map((m) => (m.file ? { kind: m.kind, file: m.file } : { kind: m.kind, url: m.url })),
    caption: f.caption.value,
    publishAt: new Date(f.publishAt.value).toISOString(),
  };
  btn.disabled = true;
  try {
    const editing = state.compose.editingId;
    if (editing) await api(`/api/posts/${editing}`, { method: 'PATCH', body });
    else await api('/api/posts', { method: 'POST', body });
    resetCompose();
    banner(editing ? 'Changes saved.' : 'Post scheduled.');
    if (state.filter !== 'calendar') selectTab('upcoming');
    await loadPosts();
  } catch (err) {
    $('#form-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

/* ---------- queue ---------- */
async function loadPosts() {
  try {
    state.posts = (await api('/api/posts')).posts;
    renderQueue();
    // While something is publishing, check back quickly instead of waiting for the 15s refresh.
    clearTimeout(state.fastRefresh);
    if (state.posts.some((p) => p.status === 'publishing' || (p.status === 'scheduled' && Date.parse(p.publishAt) <= Date.now()))) {
      state.fastRefresh = setTimeout(loadPosts, 2000);
    }
  } catch { /* login view / banner handles it */ }
}

function selectTab(filter) {
  state.filter = filter;
  document.querySelectorAll('.tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', b.dataset.filter === filter));
  renderQueue();
}

const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const TYPE_LABEL = { IMAGE: 'Image', REELS: 'Reel', CAROUSEL: 'Carousel', STORIES: 'Story' };
const GROUPS = { upcoming: ['scheduled', 'publishing'], published: ['published'], failed: ['failed'] };

function renderQueue() {
  const counts = Object.fromEntries(Object.entries(GROUPS).map(([k, s]) => [k, state.posts.filter((p) => s.includes(p.status)).length]));
  document.querySelectorAll('.tabs [role=tab]').forEach((b) => {
    const f = b.dataset.filter;
    b.textContent = `${f[0].toUpperCase()}${f.slice(1)}${f in counts ? ` (${counts[f]})` : ''}`;
  });

  const calendar = state.filter === 'calendar';
  $('#calendar').hidden = !calendar;
  $('#queue-list').hidden = calendar;
  if (calendar) { $('#queue-empty').hidden = true; renderCalendar(); return; }

  let posts = state.posts.filter((p) => GROUPS[state.filter].includes(p.status));
  if (state.filter !== 'upcoming') posts = posts.reverse();
  $('#queue-empty').hidden = posts.length > 0;
  $('#queue-list').replaceChildren(...posts.map(renderItem));
}

function thumbFor(p) {
  const first = p.media?.[0];
  const src = first && (first.file ? mediaPath(first.file) : first.url);
  let t;
  if (!first || first.kind === 'video') {
    t = first?.file ? el('video', { src, muted: true, preload: 'metadata' }) : el('div', { textContent: first ? 'VIDEO' : '—' });
  } else {
    t = el('img', { src, alt: '', loading: 'lazy' });
  }
  t.className = 'thumb';
  t.onerror = () => t.replaceWith(el('div', { className: 'thumb', textContent: 'IMG' }));
  return t;
}

function renderItem(p) {
  const meta = el('div', { className: 'item-meta' },
    el('span', { className: `status ${p.status}`, textContent: p.status + (p.dryRun ? ' · dry run' : '') }),
    el('span', { className: 'type-chip', textContent: TYPE_LABEL[p.mediaType] + (p.mediaType === 'CAROUSEL' ? ` · ${p.media.length}` : '') }),
    el('span', { textContent: fmt.format(new Date(p.publishedAt || p.publishAt)) }),
    p.permalink ? el('a', { href: p.permalink, target: '_blank', rel: 'noopener noreferrer', textContent: 'View on Instagram' }) : null,
  );
  const body = el('div', { className: 'item-body' },
    el('p', { className: 'item-cap', textContent: p.caption || (p.mediaType === 'STORIES' ? '(story)' : '(no caption)') }),
    meta,
    p.error ? el('p', { className: 'item-err', textContent: p.error }) : null,
  );

  const actions = el('div', { className: 'item-actions' });
  const add = (label, fn, cls = '') => {
    const b = el('button', { type: 'button', className: `btn small ${cls}`, textContent: label });
    b.onclick = async () => {
      b.disabled = true;
      try { await fn(); } catch (err) { banner(err.message, true); } finally { b.disabled = false; await loadPosts(); }
    };
    actions.append(b);
  };
  if (['scheduled', 'failed'].includes(p.status)) add('Edit', () => loadIntoCompose(p, { editing: true }));
  if (p.status === 'scheduled') add('Publish now', async () => (await askConfirm('Publish this post now?', 'Publish now')) && api(`/api/posts/${p.id}/publish-now`, { method: 'POST' }));
  if (p.status === 'failed') add('Retry', async () => (await askConfirm('Retry now? If the error says it was interrupted, check Instagram first so you don’t post twice.', 'Retry')) && api(`/api/posts/${p.id}/retry`, { method: 'POST' }));
  add('Duplicate', () => loadIntoCompose(p, { editing: false }));
  if (p.status !== 'publishing') {
    const published = p.status === 'published';
    add(published ? 'Remove' : 'Delete', async () => (await askConfirm(published ? 'Remove this post from the list? It stays on Instagram.' : 'Delete this post? This can’t be undone.', published ? 'Remove' : 'Delete')) && api(`/api/posts/${p.id}`, { method: 'DELETE' }), 'danger');
  }
  return el('li', { className: 'item' }, thumbFor(p), body, actions);
}

/* ---------- calendar ---------- */
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

function renderCalendar() {
  const month = state.calMonth;
  $('#cal-title').textContent = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const cells = [];
  for (let k = 0; k < 7; k++) {
    cells.push(el('div', { className: 'cal-dow', textContent: new Date(2024, 0, 1 + k).toLocaleDateString(undefined, { weekday: 'short' }) }));
  }
  const offset = (month.getDay() + 6) % 7;
  const today = new Date();
  for (let k = 0; k < 42; k++) {
    const day = new Date(month.getFullYear(), month.getMonth(), 1 - offset + k);
    const posts = state.posts
      .filter((p) => sameDay(new Date(p.publishedAt || p.publishAt), day))
      .sort((a, b) => Date.parse(a.publishedAt || a.publishAt) - Date.parse(b.publishedAt || b.publishAt));
    const cell = el('div', {
      className: `cal-cell${day.getMonth() !== month.getMonth() ? ' other' : ''}${sameDay(day, today) ? ' today' : ''}`,
    }, el('span', { className: 'cal-date', textContent: day.getDate() }));
    for (const p of posts) {
      const chip = el('button', {
        type: 'button',
        className: `cal-chip ${p.status}`,
        textContent: `${timeFmt.format(new Date(p.publishedAt || p.publishAt))} ${TYPE_LABEL[p.mediaType]}`,
        title: `${p.status}: ${p.caption || TYPE_LABEL[p.mediaType]}`,
      });
      chip.onclick = () => {
        if (['scheduled', 'failed'].includes(p.status)) loadIntoCompose(p, { editing: true });
        else if (p.permalink) window.open(p.permalink, '_blank', 'noopener');
        else banner(`${TYPE_LABEL[p.mediaType]} ${p.status}${p.dryRun ? ' (dry run)' : ''}.`);
      };
      cell.append(chip);
    }
    cells.push(cell);
  }
  $('#cal-grid').replaceChildren(...cells);
}

/* ---------- wiring ---------- */
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: { password: e.target.password.value } });
    e.target.reset();
    await showApp();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});
$('#logout-btn').onclick = async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); showLogin(); };
$('#check-btn').onclick = async (e) => {
  e.target.disabled = true;
  try {
    const { account, quota } = await api('/api/check', { method: 'POST' });
    const q = quota?.total ? ` Publishing limit: ${quota.used}/${quota.total} used in the last 24h.` : '';
    banner(`Connected as @${account.username}.${q}`);
  } catch (err) {
    banner(`Connection failed: ${err.message}`, true);
  } finally {
    e.target.disabled = false;
  }
};
$('#renew-btn').onclick = async (e) => {
  e.target.disabled = true;
  try {
    const { token } = await api('/api/token/renew', { method: 'POST' });
    renderToken(token);
    banner('Token renewed.');
  } catch (err) {
    banner(`Renewal failed: ${err.message}`, true);
    renderToken((await api('/api/status').catch(() => ({}))).token);
  } finally {
    e.target.disabled = false;
  }
};

const dz = $('#dropzone');
const fileInput = $('#file-input');
dz.onclick = () => fileInput.click();
dz.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } };
fileInput.onchange = () => { addFiles([...fileInput.files]); fileInput.value = ''; };
dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('over'); };
dz.ondragleave = () => dz.classList.remove('over');
dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove('over'); addFiles([...e.dataTransfer.files]); };
$('#url-add-btn').onclick = addUrl;
$('#url-input').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addUrl(); } };

form().addEventListener('submit', submitPost);
form().caption.addEventListener('input', updateCounters);
document.querySelectorAll('input[name=placement]').forEach((r) => r.addEventListener('change', () => {
  $('#form-error').textContent = placement() === 'STORY' && state.compose.media.length > 1
    ? 'A story takes exactly one item. Remove the extra media, or switch back to Feed post.'
    : '';
  renderCompose();
}));
$('#now-btn').onclick = () => (form().publishAt.value = toLocalInput(new Date()));
$('#cancel-edit-btn').onclick = resetCompose;
$('#prev-btn').onclick = () => { const n = state.compose.media.length; state.compose.slide = (state.compose.slide - 1 + n) % n; renderPreview(); };
$('#next-btn').onclick = () => { const n = state.compose.media.length; state.compose.slide = (state.compose.slide + 1) % n; renderPreview(); };
document.querySelectorAll('.tabs [role=tab]').forEach((b) => (b.onclick = () => selectTab(b.dataset.filter)));
$('#cal-prev').onclick = () => { state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() - 1, 1); renderCalendar(); };
$('#cal-next').onclick = () => { state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + 1, 1); renderCalendar(); };
$('#cal-today').onclick = () => { state.calMonth = startOfMonth(new Date()); renderCalendar(); };

api('/api/session').then(({ authenticated }) => (authenticated ? showApp() : showLogin())).catch(showLogin);
