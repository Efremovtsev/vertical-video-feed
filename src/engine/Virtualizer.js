// @ts-check
import { clamp, computeWindow, scrollTopFor } from 'engine/WindowCalculator.js';

/**
 * @typedef {Object} Slide  A recyclable view over one `.slide` node.
 * @property {HTMLElement} el
 * @property {() => void} release  reset to a blank/poster state (no data, no video)
 */

/**
 * The virtualization engine. Owns two things:
 *
 *  1. A permanent grid of empty `.cell` divs (the scroll spacer + snap targets).
 *     Because a snap target exists for every index at all times, a fast fling can
 *     never land in a gap. Cells size themselves from the `--slide-h` CSS var.
 *  2. A fixed pool of `poolSize` recycled `.slide` nodes, positioned purely with
 *     `transform: translate3d`. Only slides inside the window are mounted.
 *
 * It is deliberately video-agnostic: it emits `slide:enter` when an index mounts
 * (exit-side cleanup is the `Slide.release()` contract) and `cells:added` when the
 * grid grows, letting `FeedController` do data binding, playback, and observation.
 * Placement writes never read layout, so they can run synchronously without
 * thrashing.
 */
export class Virtualizer {
  #cellsEl;
  #slidesEl;
  #poolSize;
  #createSlide;
  #viewport;
  #bus;

  /** @type {HTMLElement[]} */
  #cells = [];
  /** @type {Slide[]} */
  #free = [];
  /** @type {Map<number, Slide>} index → mounted slide */
  #assigned = new Map();

  #total = 0;
  /** @type {Array<() => void>} */
  #unsub = [];

  /**
   * @param {{
   *   cellsEl: HTMLElement,
   *   slidesEl: HTMLElement,
   *   poolSize: number,
   *   createSlide: () => Slide,
   *   viewport: import('core/viewport.js').Viewport,
   *   bus: import('core/EventBus.js').EventBus,
   * }} opts
   */
  constructor({ cellsEl, slidesEl, poolSize, createSlide, viewport, bus }) {
    this.#cellsEl = cellsEl;
    this.#slidesEl = slidesEl;
    this.#poolSize = poolSize;
    this.#createSlide = createSlide;
    this.#viewport = viewport;
    this.#bus = bus;
  }

  start() {
    for (let i = 0; i < this.#poolSize; i++) {
      const slide = this.#createSlide();
      this.#slidesEl.appendChild(slide.el);
      this.#free.push(slide);
    }
    // On viewport change, cell heights follow --slide-h automatically; the slide
    // transforms are JS pixels, so re-home them from the new measured height.
    this.#unsub.push(this.#bus.on('viewport:resize', () => this.#rehome()));
  }

  /**
   * Grow the cell grid to `n` items (append-only, so scrollTop is never disturbed).
   * Called once at boot with the known total, and again only if the feed grows.
   * Emits `cells:added` with the appended cells so the observer side can track
   * them — without that, a grown feed would freeze past the old total.
   * @param {number} n
   */
  setTotal(n) {
    this.#total = n;

    if (n <= this.#cells.length) {
      return;
    }

    const frag = document.createDocumentFragment();
    /** @type {HTMLElement[]} */
    const added = [];
    for (let i = this.#cells.length; i < n; i++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.index = String(i); // read by the IntersectionObserver
      frag.appendChild(cell);
      this.#cells.push(cell);
      added.push(cell);
    }
    this.#cellsEl.appendChild(frag);
    this.#bus.emit('cells:added', { cells: added });
  }

  /** The cell elements (so FeedController can observe them). @returns {HTMLElement[]} */
  get cells() {
    return this.#cells;
  }

  /**
   * Run `cb(slide, index)` for every currently-mounted slide.
   * @param {(slide: Slide & Record<string, any>, index: number) => void} cb
   */
  eachMounted(cb) {
    for (const [index, slide] of this.#assigned) {
      cb(slide, index);
    }
  }

  /**
   * Reconcile the mounted window to be centered on `activeIndex`. Frees slides that
   * left the window and mounts newly-entered indices. Runs on active-index change
   * (not per frame), and performs no layout reads → safe to run synchronously.
   * @param {number} activeIndex
   */
  update(activeIndex) {
    if (this.#total <= 0) {
      return;
    }

    const active = clamp(activeIndex, 0, this.#total - 1);
    const { start, end } = computeWindow({
      activeIndex: active,
      total: this.#total,
      poolSize: this.#poolSize,
    });

    // Evict slides that fell outside the window. `release()` is the exit
    // contract — no event needed, the slide resets itself to a blank poster.
    for (const [index, slide] of this.#assigned) {
      if (index < start || index > end) {
        this.#assigned.delete(index);
        slide.release();
        this.#free.push(slide);
      }
    }

    // Mount indices that entered the window.
    for (let index = start; index <= end; index++) {
      if (this.#assigned.has(index)) {
        continue;
      }

      const slide = this.#free.pop();

      if (!slide) {
        continue; // impossible when poolSize ≥ window size
      }

      this.#assigned.set(index, slide);
      this.#place(slide, index);
      this.#bus.emit('slide:enter', { slide, index });
    }
  }

  /**
   * The mounted slide rendering `index`, or null if it's outside the window.
   * @param {number} index
   */
  getSlide(index) {
    return this.#assigned.get(index) ?? null;
  }

  get total() {
    return this.#total;
  }

  /** @param {Slide} slide @param {number} index */
  #place(slide, index) {
    // Same formula as the snap-target offset (keyboard nav) — one source, so the
    // transform and the scroll target can never misalign.
    slide.el.style.transform = `translate3d(0, ${scrollTopFor(index, this.#viewport.height)}px, 0)`;
  }

  #rehome() {
    for (const [index, slide] of this.#assigned) {
      this.#place(slide, index);
    }
  }

  destroy() {
    for (const off of this.#unsub) {
      off();
    }
    this.#unsub = [];
    this.#assigned.clear();
    this.#free = [];
    this.#slidesEl.replaceChildren();
    this.#cellsEl.replaceChildren();
    this.#cells = [];
  }
}
