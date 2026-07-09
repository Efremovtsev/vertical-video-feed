// @ts-check

/**
 * The single `requestAnimationFrame` loop for the whole app.
 *
 * Layout thrashing happens when code interleaves DOM *reads* (which force the
 * browser to flush pending layout) with DOM *writes*. This scheduler makes that
 * structurally impossible: every frame runs **all reads, then all writes**, then
 * continuous per-frame subscribers. No module may call `requestAnimationFrame`
 * directly — they route through here (see CLAUDE.md invariant #3).
 *
 * Ordering guarantee within one frame:
 *   1. read callbacks   — may schedule writes that run in THIS same frame
 *   2. write callbacks   — may schedule reads that run in the NEXT frame
 *   3. onFrame callbacks — continuous animations (e.g. the progress bar)
 *
 * The loop parks itself (no rAF pending) whenever there is nothing to do, so an
 * idle feed costs zero main-thread time.
 */
export class RafScheduler {
  /** @type {Array<(now: number) => void>} */
  #reads = [];
  /** @type {Array<(now: number) => void>} */
  #writes = [];
  /** @type {Set<(now: number) => void>} */
  #frame = new Set();
  #running = false;
  #rafId = 0;

  /** Schedule a DOM read for the next frame's read phase. @param {(now: number) => void} fn */
  read(fn) {
    this.#reads.push(fn);
    this.#ensure();
  }

  /** Schedule a DOM write for the next frame's write phase. @param {(now: number) => void} fn */
  write(fn) {
    this.#writes.push(fn);
    this.#ensure();
  }

  /**
   * Register a continuous per-frame callback (runs every frame until removed).
   * @param {(now: number) => void} fn
   * @returns {() => void} unsubscribe
   */
  onFrame(fn) {
    this.#frame.add(fn);
    this.#ensure();
    return () => this.#frame.delete(fn);
  }

  #ensure() {
    if (this.#running) {
      return;
    }

    this.#running = true;
    this.#rafId = requestAnimationFrame(this.#tick);
  }

  /** @param {number} now */
  #tick = (now) => {
    // Swap-and-drain so callbacks that enqueue more work don't create an
    // in-frame infinite loop. Reads run first; writes captured after reads run
    // (so a read → write in the same frame works). Reads enqueued by writes fall
    // to the next frame — exactly the ordering we want.
    const reads = this.#reads;
    this.#reads = [];
    for (const r of reads) {
      r(now);
    }

    const writes = this.#writes;
    this.#writes = [];
    for (const w of writes) {
      w(now);
    }

    for (const f of this.#frame) {
      f(now);
    }

    if (this.#reads.length || this.#writes.length || this.#frame.size) {
      this.#rafId = requestAnimationFrame(this.#tick);
    } else {
      this.#running = false;
    }
  };

  destroy() {
    if (this.#rafId) {
      cancelAnimationFrame(this.#rafId);
    }
    this.#running = false;
    this.#reads = [];
    this.#writes = [];
    this.#frame.clear();
  }
}
