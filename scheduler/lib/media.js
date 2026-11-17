// Uploaded media: saved under unguessable names and served publicly at /media/<file>
// so Instagram's servers can download them at publish time.
import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

export const FILE_RE = /^[a-f0-9]{32}\.(jpg|mp4|mov)$/;
const CONTENT_TYPES = { jpg: 'image/jpeg', mp4: 'video/mp4', mov: 'video/quicktime' };
const ACCEPT = { 'image/jpeg': 'jpg', 'video/mp4': 'mp4', 'video/quicktime': 'mov' };

const httpError = (status, message) => Object.assign(new Error(message), { status });

// Look at the file's first bytes; never trust the declared type alone.
function sniff(head) {
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg';
  if (head.subarray(4, 8).toString('latin1') === 'ftyp') {
    return head.subarray(8, 10).toString('latin1') === 'qt' ? 'mov' : 'mp4';
  }
  return null;
}

export async function createMediaStore(dataDir, { maxImageBytes = 8 * 1024 * 1024, maxVideoBytes = 300 * 1024 * 1024 } = {}) {
  const dir = join(dataDir, 'media');
  await mkdir(dir, { recursive: true });

  return {
    dir,
    async save(req) {
      const declared = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      const ext = ACCEPT[declared];
      if (!ext) {
        throw httpError(415, declared.startsWith('image/')
          ? 'Instagram only accepts JPEG images. (The dashboard converts PNG/WebP automatically.)'
          : 'Upload a JPEG image or an MP4/MOV video.');
      }
      const limit = ext === 'jpg' ? maxImageBytes : maxVideoBytes;
      if (Number(req.headers['content-length'] ?? 0) > limit) throw httpError(413, `File is larger than ${Math.round(limit / 1048576)} MB.`);

      const id = randomBytes(16).toString('hex');
      const tmp = join(dir, `${id}.part`);
      let name;
      let size = 0;
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          size += chunk.length;
          cb(size > limit ? httpError(413, `File is larger than ${Math.round(limit / 1048576)} MB.`) : null, chunk);
        },
      });
      try {
        await pipeline(req, counter, createWriteStream(tmp, { mode: 0o600 }));
        const fh = await open(tmp, 'r');
        const head = Buffer.alloc(12);
        await fh.read(head, 0, 12, 0);
        await fh.close();
        const actual = sniff(head);
        const sameFamily = actual && (actual === 'jpg') === (ext === 'jpg');
        if (!sameFamily) throw httpError(415, 'The file contents don’t match a JPEG image or MP4/MOV video.');
        name = `${id}.${actual}`;
        await rename(tmp, join(dir, name));
      } catch (err) {
        await rm(tmp, { force: true });
        throw err;
      }
      return { file: name, kind: ext === 'jpg' ? 'image' : 'video', size };
    },

    async remove(file) {
      if (FILE_RE.test(file)) await rm(join(dir, file), { force: true });
    },

    // Streams /media/<file>. Supports HEAD and simple Range requests (video players use them).
    async serve(req, res, file, extraHeaders = {}) {
      if (!FILE_RE.test(file)) return false;
      let info;
      try { info = await stat(join(dir, file)); } catch { return false; }
      const headers = {
        ...extraHeaders,
        'content-type': CONTENT_TYPES[file.split('.').pop()],
        'accept-ranges': 'bytes',
        'cache-control': 'public, max-age=31536000, immutable',
      };
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
      let start = 0;
      let end = info.size - 1;
      let status = 200;
      if (range && (range[1] || range[2])) {
        start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
        end = range[1] && range[2] ? Math.min(Number(range[2]), end) : end;
        if (start > end) {
          res.writeHead(416, { ...headers, 'content-range': `bytes */${info.size}` });
          res.end();
          return true;
        }
        status = 206;
        headers['content-range'] = `bytes ${start}-${end}/${info.size}`;
      }
      headers['content-length'] = end - start + 1;
      res.writeHead(status, headers);
      if (req.method === 'HEAD') { res.end(); return true; }
      await pipeline(createReadStream(join(dir, file), { start, end }), res).catch(() => {});
      return true;
    },
  };
}
