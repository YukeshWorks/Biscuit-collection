// Validation mirrors Instagram's documented publishing limits.
//
// A post is { placement, media[], caption, publishAt }.
//   placement: 'FEED' | 'STORY'
//   media item: { kind: 'image' | 'video', url } (a public https URL)
//            or { kind: 'image' | 'video', file } (an upload stored by this server)
// The Instagram media type is derived:
//   FEED + 1 image  -> IMAGE      FEED + 1 video -> REELS
//   FEED + 2..10    -> CAROUSEL   STORY + 1 item -> STORIES
export const LIMITS = { caption: 2200, hashtags: 30, mentions: 20, carousel: 10 };
export const PLACEMENTS = ['FEED', 'STORY'];
const FILE_RE = /^[a-f0-9]{32}\.(jpg|mp4|mov)$/;
const VIDEO_EXT = /\.(mp4|mov|m4v)(\?|#|$)/i;

export function deriveMediaType(placement, media) {
  if (placement === 'STORY') return 'STORIES';
  if (media.length > 1) return 'CAROUSEL';
  return media[0]?.kind === 'video' ? 'REELS' : 'IMAGE';
}

// Accept the original single-URL shape too: { mediaType, mediaUrl }.
function normalizeLegacy(input) {
  if (input && !input.media && input.mediaUrl) {
    const video = input.mediaType === 'REELS';
    return { ...input, placement: 'FEED', media: [{ kind: video ? 'video' : 'image', url: input.mediaUrl }] };
  }
  return input ?? {};
}

function validateItem(item, i, errors) {
  const n = `Media ${i + 1}`;
  const rawKind = item?.kind;
  if (item?.file !== undefined) {
    const file = String(item.file);
    if (!FILE_RE.test(file)) { errors.push(`${n}: invalid upload reference.`); return null; }
    return { kind: file.endsWith('.jpg') ? 'image' : 'video', file };
  }
  const url = String(item?.url ?? '').trim();
  let parsed;
  try { parsed = new URL(url); } catch { /* handled below */ }
  if (!parsed || parsed.protocol !== 'https:') {
    errors.push(`${n}: link must be a public https:// URL (Instagram downloads the file from it).`);
    return null;
  }
  if (url.length > 2048) { errors.push(`${n}: link is too long.`); return null; }
  const kind = rawKind === 'video' || rawKind === 'image' ? rawKind : VIDEO_EXT.test(url) ? 'video' : 'image';
  return { kind, url };
}

export function validatePost(rawInput, { now = Date.now() } = {}) {
  const input = normalizeLegacy(rawInput);
  const errors = [];
  const out = {};

  const placement = String(input.placement ?? 'FEED').toUpperCase();
  if (!PLACEMENTS.includes(placement)) errors.push('placement must be FEED or STORY.');
  out.placement = placement;

  const rawMedia = Array.isArray(input.media) ? input.media : [];
  const media = rawMedia.map((m, i) => validateItem(m, i, errors)).filter(Boolean);
  if (rawMedia.length === 0) errors.push('Add at least one image or video.');
  if (placement === 'STORY' && rawMedia.length > 1) errors.push('A story takes exactly one image or video.');
  if (placement === 'FEED' && rawMedia.length > LIMITS.carousel) errors.push(`A carousel can have at most ${LIMITS.carousel} items.`);
  out.media = media;
  out.mediaType = deriveMediaType(placement, media);

  const caption = placement === 'STORY' ? '' : String(input.caption ?? '');
  if (caption.length > LIMITS.caption) errors.push(`Caption is over ${LIMITS.caption} characters.`);
  const hashtags = caption.match(/#[\p{L}\p{N}_]+/gu) ?? [];
  if (hashtags.length > LIMITS.hashtags) errors.push(`Caption has more than ${LIMITS.hashtags} hashtags.`);
  const mentions = caption.match(/(^|\s)@[\w.]+/g) ?? [];
  if (mentions.length > LIMITS.mentions) errors.push(`Caption has more than ${LIMITS.mentions} @mentions.`);
  out.caption = caption;

  const publishAt = Date.parse(input.publishAt);
  if (Number.isNaN(publishAt)) errors.push('publishAt must be a valid date/time.');
  else if (publishAt < now - 60_000) errors.push('publishAt is in the past.');
  else out.publishAt = new Date(publishAt).toISOString();

  return { ok: errors.length === 0, errors, value: out };
}
