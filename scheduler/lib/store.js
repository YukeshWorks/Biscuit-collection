// Tiny JSON-file store. Writes are serialized and atomic (write temp file, then rename).
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function createStore(dataDir) {
  await mkdir(dataDir, { recursive: true });
  const file = join(dataDir, 'posts.json');
  let posts = [];
  try {
    posts = JSON.parse(await readFile(file, 'utf8'));
    if (!Array.isArray(posts)) throw new Error('posts.json is not an array');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  let queue = Promise.resolve();
  function persist() {
    const snapshot = JSON.stringify(posts, null, 2);
    queue = queue.then(async () => {
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, file);
    });
    return queue;
  }

  const clone = (p) => (p ? structuredClone(p) : null);

  return {
    list: () => posts.map(clone),
    get: (id) => clone(posts.find((p) => p.id === id)),
    async create(fields) {
      const now = new Date().toISOString();
      const post = {
        id: randomUUID(),
        status: 'scheduled',
        attempts: 0,
        containerId: null,
        igMediaId: null,
        permalink: null,
        error: null,
        publishedAt: null,
        createdAt: now,
        updatedAt: now,
        ...fields,
      };
      posts.push(post);
      await persist();
      return clone(post);
    },
    async update(id, patch) {
      const post = posts.find((p) => p.id === id);
      if (!post) return null;
      Object.assign(post, patch, { updatedAt: new Date().toISOString() });
      await persist();
      return clone(post);
    },
    async remove(id) {
      const before = posts.length;
      posts = posts.filter((p) => p.id !== id);
      if (posts.length !== before) await persist();
      return posts.length !== before;
    },
  };
}
