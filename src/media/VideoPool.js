// @ts-check

/**
 * A bounded pool of physical `<video>` elements — the scarce resource.
 *
 * Mobile GPUs expose only 1–2 hardware decoders; exceeding that throws
 * "Blocked attempt to create a WebMediaPlayer" on Chrome and starves playback on
 * iOS. So the pool caps the number of `<video>` elements at `capacity` (default 2:
 * one active + one warm neighbor) regardless of how many slides are in the DOM.
 *
 * `acquire(id, src)` reuses a warm element if that id is still held (instant
 * resume, no refetch), otherwise rebinds a free/evicted element. `release(id)` runs
 * the canonical teardown that actually frees the decoder and aborts the network
 * fetch — `pause()` alone leaks it (see CLAUDE.md invariant #5).
 *
 * LRU bookkeeping rides on `#byId`'s insertion order (a JS Map iterates in
 * insertion order): touch = delete + re-set, evict = first key. No side arrays.
 */
export class VideoPool {
  #capacity;
  #muted;
  /** @type {HTMLVideoElement[]} created elements not currently bound to an id */
  #free = [];
  /** @type {Map<string, HTMLVideoElement>} id → bound element, oldest first */
  #byId = new Map();

  /** @param {{ capacity?: number, muted?: boolean }} [opts] */
  constructor({ capacity = 2, muted = true } = {}) {
    this.#capacity = capacity;
    this.#muted = muted;
  }

  /** The decoder budget — policy code derives the warm count from this. */
  get capacity() {
    return this.#capacity;
  }

  #createElement() {
    const v = document.createElement('video');
    // Attributes (not just properties) set BEFORE any src → autoplay-policy compliant.
    v.muted = this.#muted;
    v.defaultMuted = true;
    v.setAttribute('muted', '');
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.loop = true;
    v.preload = 'metadata';
    return v;
  }

  /**
   * Get a `<video>` bound to (id, src). Reuses the element if the id is still warm.
   * The returned element is NOT mounted in the DOM — the caller mounts it.
   * @param {string} id
   * @param {string} src
   * @param {{ preload?: 'auto' | 'metadata' | 'none' }} [opts]
   * @returns {HTMLVideoElement}
   */
  acquire(id, src, { preload = 'auto' } = {}) {
    const warm = this.#byId.get(id);

    if (warm) {
      warm.preload = preload;
      this.#touch(id);
      return warm;
    }

    let el = this.#free.pop();
    if (!el) {
      el = this.#byId.size < this.#capacity ? this.#createElement() : this.#evictLRU();
    }

    el.muted = this.#muted;
    el.preload = preload;
    el.src = src;
    el.load();
    this.#byId.set(id, el);
    return el;
  }

  /** Release the element bound to `id` (decoder + buffer + DOM). @param {string} id */
  release(id) {
    if (!this.#byId.has(id)) {
      return;
    }

    this.#free.push(this.#teardown(id));
  }

  /** Release every bound element (e.g. entering a fling, or backgrounding). */
  releaseAll() {
    for (const id of [...this.#byId.keys()]) {
      this.release(id);
    }
  }

  #evictLRU() {
    const oldest = this.#byId.keys().next().value;
    return this.#teardown(/** @type {string} */ (oldest));
  }

  /**
   * The canonical release sequence. `load()` after clearing `src` re-runs the media
   * element load algorithm, which frees the decoder and aborts the in-flight fetch.
   * `remove()` detaches it from whichever slide it was mounted in.
   * @param {string} id
   * @returns {HTMLVideoElement}
   */
  #teardown(id) {
    const el = /** @type {HTMLVideoElement} */ (this.#byId.get(id));
    this.#byId.delete(id);
    el.pause();
    el.removeAttribute('src');
    el.load();
    el.remove();
    return el;
  }

  /** Move `id` to the most-recently-used end (Map insertion order). @param {string} id */
  #touch(id) {
    const el = /** @type {HTMLVideoElement} */ (this.#byId.get(id));
    this.#byId.delete(id);
    this.#byId.set(id, el);
  }

  /** @param {boolean} muted */
  setMuted(muted) {
    this.#muted = muted;
    for (const el of this.#byId.values()) {
      el.muted = muted;
    }
  }

  /** @param {string} id @returns {HTMLVideoElement | null} */
  get(id) {
    return this.#byId.get(id) ?? null;
  }

  /** @returns {string[]} currently bound ids */
  ids() {
    return [...this.#byId.keys()];
  }

  destroy() {
    this.releaseAll();
    this.#free = [];
  }
}
