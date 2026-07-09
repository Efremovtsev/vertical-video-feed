// @ts-check

/**
 * Pure windowing math — no DOM, no state, no side effects. This is the
 * correctness core of the virtualizer, kept pure so it can be unit-tested in
 * plain Node without a browser.
 */

/**
 * @param {number} v @param {number} lo @param {number} hi
 * @returns {number}
 */
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Which slide index a scroll offset rests on. Used ONLY on the settle path
 * (scrollend / idle timer), where a single scrollTop read is allowed: the
 * IntersectionObserver merely NOMINATES candidates while scrolling, but during
 * a snap re-adjustment Chrome can emit a spurious neighboring-cell
 * intersection — committing must trust measured geometry, not the last event.
 * @param {number} scrollTop
 * @param {number} slideH   measured slide height in px (> 0)
 * @param {number} total
 * @returns {number}
 */
export function indexFromScroll(scrollTop, slideH, total) {
  if (slideH <= 0 || total <= 0) {
    return 0;
  }

  // `|| 0` normalizes -0: iOS rubber-band overscroll yields negative scrollTop,
  // and Math.round(-0.4) is -0, which clamp() passes through untouched.
  return clamp(Math.round(scrollTop / slideH), 0, total - 1) || 0;
}

/**
 * The scroll offset that lands exactly on `index`.
 * @param {number} index @param {number} slideH
 * @returns {number}
 */
export function scrollTopFor(index, slideH) {
  return index * slideH;
}

/**
 * The inclusive range of indices that should be mounted, centered on the active
 * index and clamped to the feed bounds. Always yields `min(poolSize, total)`
 * indices so the fixed-size DOM pool is fully used near the edges too.
 *
 * @param {{ activeIndex: number, total: number, poolSize: number }} args
 * @returns {{ start: number, end: number }}  end < start iff the feed is empty
 */
export function computeWindow({ activeIndex, total, poolSize }) {
  const size = Math.min(poolSize, total);

  if (size <= 0) {
    return { start: 0, end: -1 };
  }

  const half = Math.floor(poolSize / 2);
  const start = clamp(activeIndex - half, 0, total - size);
  return { start, end: start + size - 1 };
}
