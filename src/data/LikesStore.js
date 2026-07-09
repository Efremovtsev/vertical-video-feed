// @ts-check

/**
 * Tiny persistence for the "like" state, keyed by video id and backed by
 * `localStorage`. The manifest carries a base like count; this store only tracks
 * which ids the viewer has liked, so the displayed count is `base + (liked ? 1 : 0)`.
 * All writes are wrapped in try/catch so private-mode / disabled storage never
 * breaks the feed.
 */
export class LikesStore {
  #key;
  /** @type {Set<string>} */
  #liked;

  /** @param {string} [storageKey] */
  constructor(storageKey = 'vvf:likes') {
    this.#key = storageKey;
    this.#liked = new Set(this.#load());
  }

  /** @returns {string[]} */
  #load() {
    try {
      const raw = localStorage.getItem(this.#key);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  #save() {
    try {
      localStorage.setItem(this.#key, JSON.stringify([...this.#liked]));
    } catch {
      /* storage unavailable — likes stay in-memory for this session */
    }
  }

  /** @param {string} id */
  isLiked(id) {
    return this.#liked.has(id);
  }

  /**
   * Flip the like state for `id`. Returns the new liked boolean.
   * @param {string} id
   * @returns {boolean}
   */
  toggle(id) {
    const liked = !this.#liked.has(id);
    if (liked) {
      this.#liked.add(id);
    } else {
      this.#liked.delete(id);
    }
    this.#save();
    return liked;
  }

  /**
   * Displayed like count for an item = manifest base + this viewer's own like.
   * @param {import('./FeedService.js').FeedItem} item
   * @returns {number}
   */
  displayCount(item) {
    return item.likes + (this.#liked.has(item.id) ? 1 : 0);
  }
}
