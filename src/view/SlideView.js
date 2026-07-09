// @ts-check
import { ActionsOverlay } from 'view/ActionsOverlay.js';

/**
 * A recyclable view over one `.slide` node (cloned from `#slide-template`). It is
 * deliberately "dumb": it binds data and toggles visual state, but performs no IO
 * and owns no playback logic. The `<video>` element is mounted/unmounted by the
 * PlaybackController — a slide only ever holds a poster by default.
 *
 * Implements the `Slide` shape the Virtualizer needs (`el`, `release()`) and the
 * `PlayableSlide` shape the PlaybackController needs.
 */
export class SlideView {
  /** @type {HTMLElement} */
  el;
  #poster;
  #videoMount;
  #progress;
  #spinner;
  #error;
  #overlay;

  /** @type {import('data/FeedService.js').FeedItem | null} */
  #item = null;

  /**
   * @param {HTMLTemplateElement} template
   * @param {import('data/LikesStore.js').LikesStore} likesStore
   */
  constructor(template, likesStore) {
    const frag = /** @type {DocumentFragment} */ (template.content.cloneNode(true));
    this.el = /** @type {HTMLElement} */ (frag.querySelector('.slide'));
    this.#poster = /** @type {HTMLImageElement} */ (this.el.querySelector('.slide__poster'));
    this.#videoMount = /** @type {HTMLElement} */ (this.el.querySelector('.slide__video'));
    this.#progress = /** @type {HTMLElement} */ (this.el.querySelector('.slide__progress'));
    this.#spinner = /** @type {HTMLElement} */ (this.el.querySelector('.slide__spinner'));
    this.#error = /** @type {HTMLElement} */ (this.el.querySelector('.slide__error'));
    this.#overlay = new ActionsOverlay(this.el, likesStore);
  }

  get item() {
    return this.#item;
  }

  /**
   * Set the bound item and DERIVE the pending state from it, so the
   * `data-pending` attribute (which drives the CSS skeleton and hides the
   * overlay) can never drift from `#item`. Pending slides keep the overlay
   * hidden because an empty overlay growing on bind is a visible layout
   * shift (CLS) — hidden boxes don't score.
   * @param {import('data/FeedService.js').FeedItem | null} item
   */
  #setItem(item) {
    this.#item = item;
    this.el.toggleAttribute('data-pending', !item);
  }

  /** The per-item visual reset every (re)bind path routes through. */
  #reset() {
    this.setProgress(0);
    this.showError(false);
    this.el.removeAttribute('data-playing'); // idle: poster only, no play icon
  }

  /**
   * Bind feed data for `index`. Resets all per-item state so no stale progress /
   * like / video leaks from the previous occupant of this recycled node.
   * @param {import('data/FeedService.js').FeedItem} item
   * @param {number} index
   */
  bind(item, index) {
    this.#setItem(item);
    this.el.dataset.index = String(index);
    this.#poster.src = item.poster;
    this.#poster.alt = item.caption;
    this.#reset();
    this.showSpinner(false);
    this.#overlay.bind(item);
  }

  /**
   * Show a "waiting for data" skeleton for an index whose page hasn't loaded.
   * @param {number} index
   */
  bindPending(index) {
    this.#setItem(null);
    this.el.dataset.index = String(index);
    this.#poster.removeAttribute('src');
    this.#reset();
    this.showSpinner(true);
  }

  /** Reset to a blank node before it's recycled to a new index. */
  release() {
    this.unmountVideo();
    this.#setItem(null);
    this.#reset();
    this.showSpinner(false);
  }

  /** @param {HTMLVideoElement} video */
  mountVideo(video) {
    if (video.parentElement !== this.#videoMount) {
      this.#videoMount.replaceChildren(video);
    }
  }

  unmountVideo() {
    // Safe: only slides at active±1 ever hold a live video, and those are far
    // inside the window — never the ones being recycled.
    this.#videoMount.replaceChildren();
  }

  /** @param {boolean} playing */
  setPlaying(playing) {
    this.el.dataset.playing = playing ? 'true' : 'false';
  }

  /**
   * Neutral playback state: not playing, but NOT user-paused either — no ▶ icon.
   * Used when a slide is merely scrolled away from; `setPlaying(false)` is
   * reserved for an explicit user pause (its ▶ icon invites a tap).
   */
  clearPlaying() {
    this.el.removeAttribute('data-playing');
  }

  /** @param {number} frac 0..1 */
  setProgress(frac) {
    this.#progress.style.transform = `scaleX(${frac})`;
  }

  /** @param {boolean} on */
  showSpinner(on) {
    this.#spinner.hidden = !on;
  }

  /** @param {boolean} on */
  showError(on) {
    this.#error.hidden = !on;
  }

  /** @param {boolean} muted */
  setMuted(muted) {
    this.#overlay.setMuteIcon(muted);
  }

  /** @param {boolean} liked @param {number} count */
  setLiked(liked, count) {
    this.#overlay.setLiked(liked, count);
  }

  burstLike() {
    this.#overlay.burst();
  }
}
