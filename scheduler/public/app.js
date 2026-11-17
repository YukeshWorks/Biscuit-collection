const $ = (s, root = document) => root.querySelector(s);
const state = { posts: [], filter: 'upcoming', refreshTimer: null };

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

function banner(text, bad = false) {
  const el = $('#banner');
  el.textContent = text;
  el.classList.toggle('bad', bad);
  el.hidden = !text;
  clearTimeout(banner.t);
  if (text) banner.t = setTimeout(() => (el.hidden = true), 6000);
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
  const status = await api('/api/status');
  const pill = $('#mode-pill');
  pill.textContent = status.dryRun ? 'Dry run' : 'Live';
  pill.className = `pill ${status.dryRun ? 'dry' : 'live'}`;
  pill.title = status.dryRun ? 'Nothing is sent to Instagram. Set DRY_RUN=false with your credentials to go live.' : `Publishing via Graph API ${status.apiVersion}`;
  renderToken(status.token);
  setDefaultTime();
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
  let text, level = '';
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

/* ---------- compose ---------- */
function toLocalInput(date) {
  const off = date.getTimezoneOffset() * 60000;
  return new Date(date - off).toISOString().slice(0, 16);
}
function setDefaultTime() {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setMinutes(0, 0, 0);
  $('#post-form').publishAt.value = toLocalInput(d);
  $('#tz-note').textContent = `Your time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
}

function updateCounters() {
  const cap = $('#post-form').caption.value;
  const tags = (cap.match(/#[\p{L}\p{N}_]+/gu) || []).length;
  const mentions = (cap.match(/(^|\s)@[\w.]+/g) || []).length;
  const set = (id, text, over) => { const el = $(id); el.textContent = text; el.classList.toggle('over', over); };
  set('#c-chars', `${cap.length}/2200`, cap.length > 2200);
  set('#c-tags', `${tags}/30 hashtags`, tags > 30);
  set('#c-mentions', `${mentions}/20 mentions`, mentions > 20);
  $('#preview-caption span').textContent = cap;
}

function updatePreview() {
  const form = $('#post-form');
  const url = form.mediaUrl.value.trim();
  const box = $('#preview-media');
  box.replaceChildren();
  if (!/^https:\/\//.test(url)) {
    box.innerHTML = '<span class="muted">Preview appears here</span>';
    return;
  }
  const el = form.mediaType.value === 'REELS' ? Object.assign(document.createElement('video'), { muted: true, loop: true, autoplay: true, playsInline: true }) : document.createElement('img');
  el.src = url;
  el.alt = 'Post preview';
  el.onerror = () => (box.innerHTML = '<span class="muted">Couldn’t load that URL</span>');
  box.append(el);
}

async function submitPost(e) {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector('[type=submit]');
  $('#form-error').textContent = '';
  btn.disabled = true;
  try {
    await api('/api/posts', {
      method: 'POST',
      body: {
        mediaType: form.mediaType.value,
        mediaUrl: form.mediaUrl.value.trim(),
        caption: form.caption.value,
        publishAt: new Date(form.publishAt.value).toISOString(),
      },
    });
    form.reset();
    setDefaultTime();
    updateCounters();
    updatePreview();
    banner('Post scheduled.');
    selectTab('upcoming');
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
  } catch { /* banner shown elsewhere / login */ }
}

function selectTab(filter) {
  state.filter = filter;
  document.querySelectorAll('.tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', b.dataset.filter === filter));
  renderQueue();
}

const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function renderQueue() {
  const groups = { upcoming: ['scheduled', 'publishing'], published: ['published'], failed: ['failed'] };
  let posts = state.posts.filter((p) => groups[state.filter].includes(p.status));
  if (state.filter === 'published') posts = posts.reverse();
  const list = $('#queue-list');
  list.replaceChildren();
  $('#queue-empty').hidden = posts.length > 0;

  const counts = Object.fromEntries(Object.entries(groups).map(([k, s]) => [k, state.posts.filter((p) => s.includes(p.status)).length]));
  document.querySelectorAll('.tabs [role=tab]').forEach((b) => {
    b.textContent = `${b.dataset.filter[0].toUpperCase()}${b.dataset.filter.slice(1)} (${counts[b.dataset.filter]})`;
  });

  for (const p of posts) {
    const li = document.createElement('li');
    li.className = 'item';

    let thumb;
    if (p.mediaType === 'REELS') {
      thumb = document.createElement('div');
      thumb.textContent = 'REEL';
    } else {
      thumb = document.createElement('img');
      thumb.src = p.mediaUrl;
      thumb.alt = '';
      thumb.loading = 'lazy';
      thumb.onerror = () => { const ph = document.createElement('div'); ph.className = 'thumb'; ph.textContent = 'IMG'; thumb.replaceWith(ph); };
    }
    thumb.className = 'thumb';

    const body = document.createElement('div');
    body.className = 'item-body';
    const cap = document.createElement('p');
    cap.className = 'item-cap';
    cap.textContent = p.caption || '(no caption)';
    const meta = document.createElement('div');
    meta.className = 'item-meta';
    const st = document.createElement('span');
    st.className = `status ${p.status}`;
    st.textContent = p.status + (p.dryRun ? ' · dry run' : '');
    const when = document.createElement('span');
    when.textContent = fmt.format(new Date(p.publishedAt || p.publishAt));
    meta.append(st, when);
    if (p.permalink) {
      const a = Object.assign(document.createElement('a'), { href: p.permalink, target: '_blank', rel: 'noopener noreferrer', textContent: 'View on Instagram' });
      meta.append(a);
    }
    body.append(cap, meta);
    if (p.error) body.append(Object.assign(document.createElement('p'), { className: 'item-err', textContent: p.error }));

    const actions = document.createElement('div');
    actions.className = 'item-actions';
    const add = (label, fn, cls = '') => {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: `btn small ${cls}`, textContent: label });
      b.onclick = async () => { b.disabled = true; try { await fn(); } catch (err) { banner(err.message, true); } finally { b.disabled = false; await loadPosts(); } };
      actions.append(b);
    };
    if (p.status === 'scheduled') add('Publish now', () => confirmed('Publish this post now?') && api(`/api/posts/${p.id}/publish-now`, { method: 'POST' }));
    if (p.status === 'failed') add('Retry', () => confirmed('Retry now? If the error says it was interrupted, check Instagram first so you don’t post twice.') && api(`/api/posts/${p.id}/retry`, { method: 'POST' }));
    if (p.status !== 'publishing') add(p.status === 'published' ? 'Remove from list' : 'Delete', () => confirmed(p.status === 'published' ? 'Remove from this list? (It stays on Instagram.)' : 'Delete this post?') && api(`/api/posts/${p.id}`, { method: 'DELETE' }), 'danger');

    li.append(thumb, body, actions);
    list.append(li);
  }
}

const confirmed = (msg) => window.confirm(msg);

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
    const { account } = await api('/api/check', { method: 'POST' });
    banner(`Connected as @${account.username}.`);
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
$('#post-form').addEventListener('submit', submitPost);
$('#post-form').caption.addEventListener('input', updateCounters);
$('#post-form').mediaUrl.addEventListener('change', updatePreview);
document.querySelectorAll('input[name=mediaType]').forEach((r) => r.addEventListener('change', updatePreview));
$('#now-btn').onclick = () => ($('#post-form').publishAt.value = toLocalInput(new Date()));
document.querySelectorAll('.tabs [role=tab]').forEach((b) => (b.onclick = () => selectTab(b.dataset.filter)));

api('/api/session').then(({ authenticated }) => (authenticated ? showApp() : showLogin())).catch(showLogin);
