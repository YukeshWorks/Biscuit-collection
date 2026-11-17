// Publishes due posts one at a time. Ticks never overlap.
export function createScheduler({ store, client, now = () => Date.now(), log = console }) {
  let running = false;
  let timer = null;

  async function publishOne(id) {
    const post = store.get(id);
    if (!post || post.status !== 'scheduled') return;
    await store.update(id, { status: 'publishing', attempts: post.attempts + 1, error: null });
    try {
      const result = await client.publish(post, {
        onContainer: (containerId) => store.update(id, { containerId }),
      });
      await store.update(id, {
        status: 'published',
        igMediaId: result.id,
        permalink: result.permalink,
        dryRun: result.dryRun,
        publishedAt: new Date(now()).toISOString(),
      });
      log.info?.(`[scheduler] published ${id}${result.dryRun ? ' (dry run)' : ''}`);
    } catch (err) {
      await store.update(id, { status: 'failed', error: String(err.message).slice(0, 500) });
      log.warn?.(`[scheduler] failed ${id}: ${err.message}`);
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const due = store
        .list()
        .filter((p) => p.status === 'scheduled' && Date.parse(p.publishAt) <= now())
        .sort((a, b) => Date.parse(a.publishAt) - Date.parse(b.publishAt));
      for (const post of due) await publishOne(post.id);
    } finally {
      running = false;
    }
  }

  // A post left in "publishing" means the process died mid-publish. We can't know whether
  // Instagram received it, so mark it failed instead of retrying (avoids duplicate posts).
  async function recover() {
    for (const post of store.list().filter((p) => p.status === 'publishing')) {
      await store.update(post.id, {
        status: 'failed',
        error: 'Interrupted while publishing. Check your Instagram profile before retrying.',
      });
    }
  }

  return {
    tick,
    recover,
    start(intervalMs = 30_000) {
      timer = setInterval(() => tick().catch((e) => log.error?.(e)), intervalMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
    },
  };
}
