// @ts-check

/**
 * @typedef {Object} PlayableSlide  the subset of SlideView this controller uses.
 * @property {(video: HTMLVideoElement) => void} mountVideo
 * @property {() => void} unmountVideo
 * @property {(playing: boolean) => void} setPlaying
 * @property {() => void} clearPlaying
 * @property {(frac: number) => void} setProgress
 * @property {(on: boolean) => void} showSpinner
 * @property {(on: boolean) => void} showError
 */

/**
 * Playback policy. Decides which slide holds the single active decoder, warms the
 * next neighbor, and enforces the mute policy. Key resource rules:
 *
 *  - **1 active + 1 warm.** Everything else shows a poster with no decoder.
 *  - **No decoding during a fling.** `suspend()` releases the pool so a fast fling
 *    doesn't spin up/tear down a decoder per passed slide; `setActive()` (called on
 *    settle) acquires exactly one decoder at the destination.
 *  - **Muted-first + inherited global mute.** Autoplay always starts muted; the
 *    global mute flag is applied to whichever element becomes active.
 *  - Every `play()` is guarded: `AbortError` (fling race) is swallowed;
 *    `NotAllowedError` (autoplay blocked) means "stay muted / needs gesture".
 */
export class PlaybackController {
  #pool;
  #scheduler;
  #bus;
  #getItem;
  #getSlide;

  #activeIndex = -1;
  #muted = true;
  #suspended = false;
  // An EXPLICIT tap-pause. Modeled as state so a scroll nudge or a tab return
  // that re-commits the same slide doesn't autoplay over the user's decision.
  #userPaused = false;
  /** @type {(() => void) | null} */
  #progressOff = null;
  /** @type {(() => void) | null} */
  #eventsOff = null;

  /**
   * @param {{
   *   pool: import('./VideoPool.js').VideoPool,
   *   scheduler: import('core/RafScheduler.js').RafScheduler,
   *   bus: import('core/EventBus.js').EventBus,
   *   getItem: (index: number) => (import('data/FeedService.js').FeedItem | null),
   *   getSlide: (index: number) => (PlayableSlide | null),
   * }} opts
   */
  constructor({ pool, scheduler, bus, getItem, getSlide }) {
    this.#pool = pool;
    this.#scheduler = scheduler;
    this.#bus = bus;
    this.#getItem = getItem;
    this.#getSlide = getSlide;
  }

  get muted() {
    return this.#muted;
  }

  /**
   * Commit `index` as the single active slide: play its video, warm the neighbor
   * the viewer is moving toward, release everything else. Called on scroll settle
   * (never mid-fling).
   * @param {number} index
   * @param {1 | -1} [direction] scroll direction; the warm neighbor sits ahead
   *   of the viewer, not always below (scrolling up warms `index - 1`).
   */
  setActive(index, direction = 1) {
    if (index !== this.#activeIndex) {
      this.#userPaused = false; // a NEW slide always autoplays fresh
    }

    const item = this.#getItem(index);
    // Page not loaded yet — FeedController re-invokes us on `feed:page`.
    if (!item) {
      this.#activeIndex = index;
      this.#suspended = false;
      return;
    }

    const next = this.#getItem(index + direction);
    const keep = new Set([item.id]);
    if (next) {
      keep.add(next.id);
    }
    for (const id of this.#pool.ids()) {
      if (!keep.has(id)) {
        this.#pool.release(id);
      }
    }

    this.#activeIndex = index;
    this.#suspended = false;

    // Active: mount, wire state events, play, drive the progress bar.
    const slide = this.#getSlide(index);
    const el = this.#pool.acquire(item.id, item.src, { preload: 'auto' });
    el.muted = this.#muted;
    if (slide) {
      slide.showError(false);
      slide.mountVideo(el);
      slide.showSpinner(el.readyState < 2 /* HAVE_CURRENT_DATA */);
    }
    this.#wireActiveEvents(el, slide);

    // The 'error' event may have fired while the element was WARM — before any
    // listener existed — and events don't replay. Without this check the user
    // would face an eternal spinner; Retry releases and re-acquires fresh.
    if (el.error) {
      slide?.showSpinner(false);
      slide?.showError(true);
      return;
    }

    if (this.#userPaused) {
      // Re-commit of the slide the user explicitly paused (scroll nudge, tab
      // return): restore the paused presentation instead of autoplaying.
      slide?.setPlaying(false);
    } else {
      this.#play(el);
      this.#startProgress(el, slide);
    }

    // Warm neighbor: buffer metadata, paused, poster still showing. The warm
    // count derives from the pool's capacity (capacity − 1 = 1), so the budget
    // knob in main.js stays the single source — capacity 1 must not evict the
    // active decoder to warm a neighbor.
    if (next && this.#pool.capacity > 1) {
      const warm = this.#pool.acquire(next.id, next.src, { preload: 'metadata' });
      this.#getSlide(index + direction)?.mountVideo(warm);
    }
  }

  /** Enter fling mode: drop all decoders, let posters bridge. Idempotent. */
  suspend() {
    if (this.#suspended) {
      return;
    }

    this.#suspended = true;
    this.#stopProgress();
    this.#getSlide(this.#activeIndex)?.clearPlaying();
    this.#pool.releaseAll();
  }

  /** Toggle play/pause on the active video (tap). */
  togglePlay() {
    const el = this.#activeEl();

    if (!el) {
      return;
    }

    if (el.paused) {
      this.#userPaused = false;
      this.#play(el);
      this.#getSlide(this.#activeIndex)?.setPlaying(true);
      this.#startProgress(el, this.#getSlide(this.#activeIndex));
    } else {
      // pause() also stops the per-frame progress tick so the rAF loop parks.
      this.pause();
      // …but an EXPLICIT user pause is remembered and shows the ▶ icon.
      this.#userPaused = true;
      this.#getSlide(this.#activeIndex)?.setPlaying(false);
    }
  }

  /** Flip global mute; applies to the active element and is inherited by later ones. */
  toggleMute() {
    this.setMuted(!this.#muted);
  }

  /** @param {boolean} muted */
  setMuted(muted) {
    this.#muted = muted;
    this.#pool.setMuted(muted);
    this.#bus.emit('mute:changed', muted);
  }

  /** Force-reload the active video after an error (retry button). @param {number} index */
  reload(index) {
    const item = this.#getItem(index);
    if (item) {
      this.#pool.release(item.id);
    }
    this.setActive(index);
  }

  /**
   * Pause the active video without releasing its decoder (scrolling away).
   * Leaves the slide in the NEUTRAL state — no ▶ icon. A slide that's merely
   * being scrolled away from isn't "user-paused", and flashing ▶ on it reads
   * as UI noise during every swipe.
   */
  pause() {
    this.#activeEl()?.pause();
    this.#stopProgress();
    this.#getSlide(this.#activeIndex)?.clearPlaying();
  }

  /** Backgrounded: pause and free ALL decoders. FeedController re-commits on return. */
  onHidden() {
    this.pause();
    this.#pool.releaseAll();
  }

  #activeEl() {
    const item = this.#getItem(this.#activeIndex);
    return item ? this.#pool.get(item.id) : null;
  }

  /** @param {HTMLVideoElement} el */
  #play(el) {
    const p = el.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        // Deliberately swallowed — neither is an app error (CLAUDE.md #9):
        // AbortError: the normal fling race (pause()/load() landed first);
        // NotAllowedError: autoplay blocked (e.g. iOS Low Power Mode) — the
        // poster stays up and the user's next tap retries via togglePlay().
      });
    }
  }

  /**
   * @param {HTMLVideoElement} el
   * @param {PlayableSlide | null} slide
   */
  #wireActiveEvents(el, slide) {
    this.#eventsOff?.();
    const onPlaying = () => {
      slide?.setPlaying(true);
      slide?.showSpinner(false);
    };
    const onWaiting = () => slide?.showSpinner(true);
    const onCanPlay = () => slide?.showSpinner(false);
    const onError = () => {
      slide?.showSpinner(false);
      slide?.showError(true);
    };
    el.addEventListener('playing', onPlaying);
    el.addEventListener('waiting', onWaiting);
    el.addEventListener('canplay', onCanPlay);
    el.addEventListener('error', onError);
    this.#eventsOff = () => {
      el.removeEventListener('playing', onPlaying);
      el.removeEventListener('waiting', onWaiting);
      el.removeEventListener('canplay', onCanPlay);
      el.removeEventListener('error', onError);
    };
  }

  /**
   * @param {HTMLVideoElement} el
   * @param {PlayableSlide | null} slide
   */
  #startProgress(el, slide) {
    this.#stopProgress();

    if (!slide) {
      return;
    }

    // Reads `currentTime` (not a layout read) and writes a compositor-only scaleX.
    // Quantized to ~512 steps with identical writes skipped: sub-pixel progress
    // would otherwise allocate a fresh transform string every frame for no
    // visible change (the bar is at most ~500px wide).
    let last = -1;
    this.#progressOff = this.#scheduler.onFrame(() => {
      const d = el.duration;

      if (!(d > 0)) {
        return;
      }

      const frac = Math.min(1, (((el.currentTime / d) * 512) | 0) / 512);
      if (frac !== last) {
        last = frac;
        slide.setProgress(frac);
      }
    });
  }

  #stopProgress() {
    this.#progressOff?.();
    this.#progressOff = null;
  }

  destroy() {
    this.#stopProgress();
    this.#eventsOff?.();
    this.#pool.destroy();
  }
}
