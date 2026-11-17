// Turns a GitHub issue created from .github/ISSUE_TEMPLATE/instagram-post.yml into a post.
// The issue form renders as Markdown: "### <label>\n\n<value>" per field, with
// "_No response_" for empty optional fields.

export const LABELS = {
  placement: 'Where should it go?',
  when: 'When should it go live?',
  timezone: 'Time zone',
  media: 'Photos or videos',
  caption: 'Caption',
};

export function parseIssueForm(body) {
  const fields = {};
  const parts = String(body ?? '').replace(/\r\n/g, '\n').split(/^### +/m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const label = (nl === -1 ? part : part.slice(0, nl)).trim();
    let value = nl === -1 ? '' : part.slice(nl + 1).trim();
    if (value === '_No response_') value = '';
    const key = Object.keys(LABELS).find((k) => LABELS[k] === label);
    if (key) fields[key] = value;
  }
  return fields;
}

// ---- time ----
export function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function tzOffsetMs(ts, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ts)).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

// Wall-clock time in a zone -> UTC epoch ms (handles DST by re-checking the offset).
export function zonedTimeToUtc(y, mo, d, h, mi, timeZone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let ts = guess - tzOffsetMs(guess, timeZone);
  ts = guess - tzOffsetMs(ts, timeZone);
  return ts;
}

// Accepts "now", ISO strings with Z/offset, or "YYYY-MM-DD HH:MM" (also "T", seconds, "+05:30").
export function parseWhen(text, timeZone, now = Date.now()) {
  const t = String(text ?? '').trim();
  if (!t) return { error: 'Add a date and time (for example 2026-11-20 18:30), or type now.' };
  if (/^now$/i.test(t)) return { ts: now };
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(t);
  if (!m) return { error: `Couldn't read the time "${t}". Use the format 2026-11-20 18:30, or type now.` };
  const [, y, mo, d, h, mi, , off] = m;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59) return { error: `"${t}" isn't a real date and time.` };
  if (off) {
    const iso = `${y}-${mo}-${d}T${h.padStart(2, '0')}:${mi}:00${off.toUpperCase() === 'Z' ? 'Z' : off.length === 5 ? `${off.slice(0, 3)}:${off.slice(3)}` : off}`;
    const ts = Date.parse(iso);
    return Number.isNaN(ts) ? { error: `"${t}" isn't a real date and time.` } : { ts };
  }
  return { ts: zonedTimeToUtc(+y, +mo, +d, +h, +mi, timeZone) };
}

// ---- media ----
export function extractUrls(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text ?? '').match(/https:\/\/[^\s)<>"'\]]+/g) ?? []) {
    const url = raw.replace(/[.,;]+$/, '');
    if (!seen.has(url)) { seen.add(url); out.push(url); }
  }
  return out;
}

export function sniffKind(bytes) {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image' };
  if (b.length >= 8 && Buffer.from(b.subarray(4, 8)).toString('latin1') === 'ftyp') {
    const brand = Buffer.from(b.subarray(8, 12)).toString('latin1');
    if (/^(heic|heix|mif1|msf1|avif)/.test(brand)) return { error: 'is a HEIC/AVIF photo. Instagram needs JPEG: export or share it as JPEG (on iPhone: Settings → Camera → Formats → Most Compatible).' };
    return { kind: 'video' };
  }
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { error: 'is a PNG. Instagram only accepts JPEG photos: export it as JPEG and upload again.' };
  if (b.length >= 12 && Buffer.from(b.subarray(0, 4)).toString('latin1') === 'RIFF' && Buffer.from(b.subarray(8, 12)).toString('latin1') === 'WEBP') return { error: 'is a WebP image. Instagram only accepts JPEG photos: export it as JPEG.' };
  if (b.length >= 3 && Buffer.from(b.subarray(0, 3)).toString('latin1') === 'GIF') return { error: 'is a GIF. Use a JPEG photo or an MP4 video instead.' };
  return { error: 'isn’t a JPEG photo or MP4/MOV video (or the link isn’t public).' };
}

// Follows redirects (GitHub attachment links redirect to signed storage URLs) and reads the
// first bytes to learn what the file is. Returns the final direct URL Instagram should fetch.
export async function resolveMedia(url, fetchImpl = globalThis.fetch) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { range: 'bytes=0-31', 'user-agent': 'biscuit-post-scheduler' }, redirect: 'follow' });
  } catch (err) {
    return { error: `couldn’t be downloaded (${err.message}).` };
  }
  if (!res.ok) return { error: `couldn’t be downloaded (HTTP ${res.status}). Make sure it’s public.` };
  const buf = new Uint8Array(await res.arrayBuffer()).subarray(0, 32);
  const sniffed = sniffKind(buf);
  if (sniffed.error) return sniffed;
  const finalUrl = res.url && res.url.startsWith('https://') ? res.url : url;
  return { kind: sniffed.kind, url: finalUrl };
}

export function placementFrom(text) {
  return /story/i.test(String(text ?? '')) ? 'STORY' : 'FEED';
}
