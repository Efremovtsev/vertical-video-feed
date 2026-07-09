// @ts-check

/**
 * Translates raw pointer/click events on the feed root into semantic intents,
 * emitted on the bus as `intent` `{ type, index?, gesture? }`. ONE delegated
 * listener set lives on the root — never per-slide (they're recycled). The feed's
 * own vertical dragging is left entirely to native scroll-snap; we only interpret
 * taps.
 *
 * - tap on the play surface → `toggle-play`
 * - double-tap on the play surface → `like` (with a heart burst)
 * - click on a rail button → its `data-action` (`like` / `comment` / `share` / `mute`)
 * - click on the retry button → `retry`
 */
/**
 * Two taps within this window count as a double-tap; a single tap defers this
 * long before committing. Exported so other layers can reference the policy by
 * name instead of re-stating the number.
 */
export const DOUBLE_TAP_MS = 280;

export class GestureController {
  #root;
  #bus;
  #moveTol = 12; // px; more movement than this is a scroll, not a tap
  #lastTapAt = 0;
  #lastX = 0;
  #lastY = 0;
  #downX = 0;
  #downY = 0;
  #singleTimer = 0;

  /** @param {{ root: HTMLElement, bus: import('core/EventBus.js').EventBus }} opts */
  constructor({ root, bus }) {
    this.#root = root;
    this.#bus = bus;
  }

  start() {
    this.#root.addEventListener('click', this.#onClick);
    this.#root.addEventListener('pointerdown', this.#onDown, { passive: true });
    this.#root.addEventListener('pointerup', this.#onUp, { passive: true });
  }

  /** @param {Element} el */
  #indexOf(el) {
    const slide = el.closest('.slide');
    return slide ? Number(/** @type {HTMLElement} */ (slide).dataset.index) : -1;
  }

  /** @param {MouseEvent} e */
  #onClick = (e) => {
    const btn = /** @type {HTMLElement | null} */ (
      /** @type {Element} */ (e.target).closest('.action, [data-action="retry"]')
    );

    if (!btn) {
      return; // the big play surface is handled by tap logic, not click
    }

    e.preventDefault();
    this.#bus.emit('intent', { type: btn.dataset.action, index: this.#indexOf(btn) });
  };

  /** @param {PointerEvent} e */
  #onDown = (e) => {
    this.#downX = e.clientX;
    this.#downY = e.clientY;
  };

  /** @param {PointerEvent} e */
  #onUp = (e) => {
    const target = /** @type {Element} */ (e.target);

    if (target.closest('.action, .slide__error')) {
      return; // buttons → click handler
    }

    if (Math.hypot(e.clientX - this.#downX, e.clientY - this.#downY) > this.#moveTol) {
      return; // was a scroll
    }

    const index = this.#indexOf(target);

    if (index < 0) {
      return;
    }

    const now = e.timeStamp;
    const isDouble =
      now - this.#lastTapAt < DOUBLE_TAP_MS &&
      Math.hypot(e.clientX - this.#lastX, e.clientY - this.#lastY) < 40;

    if (isDouble) {
      clearTimeout(this.#singleTimer);
      this.#singleTimer = 0;
      this.#lastTapAt = 0;
      this.#bus.emit('intent', { type: 'like', index, gesture: 'double-tap' });
      return;
    }

    // Single tap: defer briefly so a second tap can upgrade it to a double-tap.
    this.#lastTapAt = now;
    this.#lastX = e.clientX;
    this.#lastY = e.clientY;
    clearTimeout(this.#singleTimer);
    this.#singleTimer = window.setTimeout(() => {
      this.#bus.emit('intent', { type: 'toggle-play', index });
      this.#singleTimer = 0;
    }, DOUBLE_TAP_MS);
  };

  destroy() {
    clearTimeout(this.#singleTimer);
    this.#root.removeEventListener('click', this.#onClick);
    this.#root.removeEventListener('pointerdown', this.#onDown);
    this.#root.removeEventListener('pointerup', this.#onUp);
  }
}
