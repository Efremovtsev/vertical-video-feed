// @ts-check

/**
 * Single source of truth for the slide height `H` in **CSS pixels**.
 *
 * Why measured px instead of `100dvh`: the mobile URL bar collapses/expands and
 * changes the visual viewport. If the cells used `dvh` (CSS) while the slide
 * transforms used JS pixels, the two would drift out of alignment and snap would
 * jitter by a pixel. Measuring one `H` and driving both the CSS custom property
 * (`--slide-h`) and every transform from it keeps snap points integer-aligned.
 *
 * Publishes `--slide-h` on `:root` and emits `viewport:resize` (with the new H)
 * whenever the height actually changes (orientation, URL-bar show/hide).
 */
export class Viewport {
  #el;
  #bus;
  #h = 0;
  /** @type {ResizeObserver | null} */
  #ro = null;

  /**
   * @param {HTMLElement} feedEl the scroll container
   * @param {import('./EventBus.js').EventBus} bus
   */
  constructor(feedEl, bus) {
    this.#el = feedEl;
    this.#bus = bus;
  }

  start() {
    this.#measure();
    this.#ro = new ResizeObserver(() => this.#measure());
    this.#ro.observe(this.#el);
    window.visualViewport?.addEventListener('resize', this.#onVisualViewport, { passive: true });
    window.addEventListener('orientationchange', this.#onVisualViewport, { passive: true });
  }

  #onVisualViewport = () => this.#measure();

  #measure() {
    const h = Math.round(this.#el.clientHeight);

    if (h === 0 || h === this.#h) {
      return;
    }

    this.#h = h;
    document.documentElement.style.setProperty('--slide-h', `${h}px`);
    this.#bus.emit('viewport:resize', h);
  }

  /** Current measured slide height in px. */
  get height() {
    return this.#h;
  }

  destroy() {
    this.#ro?.disconnect();
    window.visualViewport?.removeEventListener('resize', this.#onVisualViewport);
    window.removeEventListener('orientationchange', this.#onVisualViewport);
  }
}
