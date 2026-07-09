// @ts-check

/**
 * The single source of truth for the feed-manifest file layout. Imported by BOTH
 * the runtime client (`data/FeedService.js`, via the import map) and the
 * build-time generator (`scripts/build-feed.mjs`, via a relative path), so the
 * producer and the consumer can never drift apart on file naming.
 */

/** Repo-relative directory the manifest lives in (producer writes, consumer fetches). */
export const FEED_DIR = 'public/feed';

export const INDEX_FILE = 'index.json';

/**
 * How many pages a feed of `total` items paginates into. Shared so the
 * producer's paging and the consumer's bounds check can never disagree.
 * @param {number} total @param {number} pageSize
 * @returns {number}
 */
export function pageCount(total, pageSize) {
  return Math.ceil(total / pageSize);
}

/**
 * @param {number} page
 * @returns {string} e.g. 7 → "page-007.json"
 */
export function pageFileName(page) {
  return `page-${String(page).padStart(3, '0')}.json`;
}

/** Matches generated page files (used by the build script's stale-page cleanup). */
export const PAGE_FILE_RE = /^page-\d+\.json$/;
