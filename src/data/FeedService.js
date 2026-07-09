// @ts-check
import { FEED_DIR, INDEX_FILE, pageCount, pageFileName } from 'data/manifest.js';

/**
 * @typedef {Object} FeedItem
 * @property {string} id
 * @property {string} src      path to the .mp4
 * @property {string} poster   path to the poster image
 * @property {string} author
 * @property {string} caption
 * @property {number} likes    base like count from the manifest
 * @property {number} duration seconds
 * @property {number} [width]
 * @property {number} [height]
 */

/**
 * Paginated manifest client. The feed is a set of static JSON pages
 * (`public/feed/index.json` + `page-NNN.json`), but the app consumes them exactly
 * like a real paginated API: pages load lazily as the viewer approaches them,
 * in-flight requests are de-duplicated, and the next page is prefetched ahead of
 * time. Total is known up front (from index.json) so the scroll spacer never has
 * to jump.
 *
 * Emits:
 *   `feed:page`  { page, items }  — a page finished loading (re-bind waiting slides)
 *   `feed:error` { page, error }  — a page failed (show retry)
 */
export class FeedService {
  #baseUrl;
  #bus;
  #pageSize = 0;
  #total = 0;
  /** @type {Map<number, FeedItem[]>} */
  #pages = new Map();
  /** @type {Map<number, Promise<FeedItem[] | null>>} */
  #inflight = new Map();

  /**
   * @param {{ baseUrl?: string, bus: import('core/EventBus.js').EventBus }} opts
   */
  constructor({ baseUrl = FEED_DIR, bus }) {
    this.#baseUrl = baseUrl;
    this.#bus = bus;
  }

  /**
   * Load the index + first page. The first page's filename is deterministic
   * (`pageFileName(0)`), so both fetches run in parallel — one fewer network
   * round-trip on the boot-spinner critical path. Resolves with `{ total }`.
   */
  async init() {
    // .catch at creation: if this rejects while we're still awaiting the index,
    // the rejection must already have a handler (no unhandled-rejection window).
    const firstPage = this.#fetchPage(0).catch(() => null);
    const res = await fetch(`${this.#baseUrl}/${INDEX_FILE}`);

    if (!res.ok) {
      throw new Error(`feed index: HTTP ${res.status}`);
    }

    const idx = await res.json();
    this.#pageSize = idx.pageSize;
    this.#total = idx.total;
    const first = await firstPage;

    if (!first) {
      throw new Error('feed: first page failed to load');
    }

    this.#pages.set(0, first);
    this.#bus.emit('feed:page', { page: 0, items: first });
    return { total: this.#total };
  }

  #totalPages() {
    return pageCount(this.#total, this.#pageSize);
  }

  /** @param {number} index */
  pageOf(index) {
    return Math.floor(index / this.#pageSize);
  }

  /**
   * The item at `index`, or null if its page isn't loaded yet.
   * @param {number} index
   * @returns {FeedItem | null}
   */
  getItem(index) {
    const page = this.#pages.get(this.pageOf(index));
    return page ? (page[index % this.#pageSize] ?? null) : null;
  }

  /**
   * Ensure the page containing `index` is loading, and prefetch the next page once
   * the viewer is into the second half of the current one. This is the
   * infinite-scroll trigger. Runs on every candidate change during a fling, so
   * already-loaded pages bail before any promise is created.
   * @param {number} index
   */
  ensureAround(index) {
    const page = this.pageOf(index);

    if (!this.#pages.has(page)) {
      void this.loadPage(page);
    }

    const next = page + 1;

    if (index % this.#pageSize >= Math.floor(this.#pageSize / 2) && !this.#pages.has(next)) {
      void this.loadPage(next);
    }
  }

  /**
   * Raw page fetch — no caching, throws on HTTP errors.
   * @param {number} page
   * @returns {Promise<FeedItem[]>}
   */
  #fetchPage(page) {
    return fetch(`${this.#baseUrl}/${pageFileName(page)}`).then((r) => {
      if (!r.ok) {
        throw new Error(`page ${page}: HTTP ${r.status}`);
      }

      return r.json();
    });
  }

  /**
   * Fetch a page (de-duped and cached). Emits `feed:page` on success and
   * `feed:error` on failure — errors resolve to `null` rather than rejecting, so
   * fire-and-forget callers (`ensureAround`) never produce unhandled rejections.
   * @param {number} page
   * @returns {Promise<FeedItem[] | null>}
   */
  loadPage(page) {
    if (page < 0 || page >= this.#totalPages()) {
      return Promise.resolve(null);
    }

    const cached = this.#pages.get(page);

    if (cached) {
      return Promise.resolve(cached);
    }

    const existing = this.#inflight.get(page);

    if (existing) {
      return existing;
    }

    const promise = this.#fetchPage(page)
      .then((items) => {
        this.#pages.set(page, items);
        this.#inflight.delete(page);
        this.#bus.emit('feed:page', { page, items });
        return items;
      })
      .catch((error) => {
        this.#inflight.delete(page);
        this.#bus.emit('feed:error', { page, error });
        return null;
      });

    this.#inflight.set(page, promise);
    return promise;
  }
}
