// Validation mirrors Instagram's documented publishing limits.
export const LIMITS = { caption: 2200, hashtags: 30, mentions: 20 };
export const MEDIA_TYPES = ['IMAGE', 'REELS'];

export function validatePost(input, { now = Date.now() } = {}) {
  const errors = [];
  const out = {};

  const mediaType = String(input?.mediaType ?? 'IMAGE').toUpperCase();
  if (!MEDIA_TYPES.includes(mediaType)) errors.push('mediaType must be IMAGE or REELS.');
  out.mediaType = mediaType;

  const mediaUrl = String(input?.mediaUrl ?? '').trim();
  let parsed;
  try { parsed = new URL(mediaUrl); } catch { /* handled below */ }
  if (!parsed || parsed.protocol !== 'https:') {
    errors.push('mediaUrl must be a public https:// link (Instagram downloads the file from it).');
  } else if (mediaUrl.length > 2048) {
    errors.push('mediaUrl is too long.');
  }
  out.mediaUrl = mediaUrl;

  const caption = String(input?.caption ?? '');
  if (caption.length > LIMITS.caption) errors.push(`Caption is over ${LIMITS.caption} characters.`);
  const hashtags = caption.match(/#[\p{L}\p{N}_]+/gu) ?? [];
  if (hashtags.length > LIMITS.hashtags) errors.push(`Caption has more than ${LIMITS.hashtags} hashtags.`);
  const mentions = caption.match(/(^|\s)@[\w.]+/g) ?? [];
  if (mentions.length > LIMITS.mentions) errors.push(`Caption has more than ${LIMITS.mentions} @mentions.`);
  out.caption = caption;

  const publishAt = Date.parse(input?.publishAt);
  if (Number.isNaN(publishAt)) errors.push('publishAt must be a valid date/time.');
  else if (publishAt < now - 60_000) errors.push('publishAt is in the past.');
  else out.publishAt = new Date(publishAt).toISOString();

  return { ok: errors.length === 0, errors, value: out };
}
