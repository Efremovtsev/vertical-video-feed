// @ts-check

/**
 * Desktop keyboard navigation, emitted as the same `intent` events the gestures
 * use so `FeedController` has a single handler. Expressed as intents (not direct
 * DOM manipulation) so it composes with native scroll-snap instead of fighting it.
 *
 * - ArrowDown / j → `nav` +1        - ArrowUp / k → `nav` -1
 * - Space         → `toggle-play`    - m          → `mute`
 */
export class KeyboardController {
  #bus;

  /** @param {{ bus: import('core/EventBus.js').EventBus }} opts */
  constructor({ bus }) {
    this.#bus = bus;
  }

  start() {
    window.addEventListener('keydown', this.#onKey);
  }

  /** @param {KeyboardEvent} e */
  #onKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) {
      return;
    }

    // Never steal keys from a focused interactive element: Space on a focused
    // like-button must activate the button, not toggle playback.
    if (
      e.target instanceof Element &&
      e.target.closest('button, a, input, select, textarea, [contenteditable]')
    ) {
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
      case 'j':
        e.preventDefault();
        this.#bus.emit('intent', { type: 'nav', delta: 1 });
        break;
      case 'ArrowUp':
      case 'k':
        e.preventDefault();
        this.#bus.emit('intent', { type: 'nav', delta: -1 });
        break;
      case ' ':
        e.preventDefault(); // don't page-scroll
        this.#bus.emit('intent', { type: 'toggle-play' });
        break;
      case 'm':
      case 'M':
        this.#bus.emit('intent', { type: 'mute' });
        break;
    }
  };

  destroy() {
    window.removeEventListener('keydown', this.#onKey);
  }
}
