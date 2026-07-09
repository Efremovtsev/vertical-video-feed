// @ts-check
import { clamp, indexFromScroll, scrollTopFor } from 'engine/WindowCalculator.js';

const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)');

/**
 * The mediator. The single place that understands the whole lifecycle; every other
 * module stays decoupled and talks only through the EventBus. It:
 *
 *  - detects the centered slide with an IntersectionObserver (center-band
 *    rootMargin), so a fast fling still reports each crossed slide — no scrollTop
 *    polling during scroll;
 *  - follows the scroll with the recycled window (posters bridge) and pauses the
 *    outgoing audio, but commits playback only on **settle** (`scrollend`, with an
 *    idle-timer fallback) so a fling spins up exactly one decoder at the destination;
 *  - binds feed data on `slide:enter`, re-binds pending slides on `feed:page`;
 *  - routes `intent`s (like / mute / play-pause / nav / retry).
 */
export class FeedController {
  #feedEl;
  #bootEl;
  #bus;
  #viewport;
  #virtualizer;
  #feed;
  #playback;
  #likes;

  #activeIndex = 0;
  #candidate = 0;
  /** @type {1 | -1} last committed scroll direction (for the warm neighbor) */
  #direction = 1;
  /** @type {number | null} pending keyboard-nav target; null when settled */
  #navTarget = null;
  /** @type {IntersectionObserver | null} */
  #io = null;
  #idleTimer = 0;
  /** @type {Array<() => void>} */
  #offs = [];

  /**
   * @param {{
   *   feedEl: HTMLElement, bootEl: HTMLElement,
   *   bus: import('app/events.js').AppBus,
   *   viewport: import('core/viewport.js').Viewport,
   *   virtualizer: import('engine/Virtualizer.js').Virtualizer,
   *   feedService: import('data/FeedService.js').FeedService,
   *   playback: import('media/PlaybackController.js').PlaybackController,
   *   likes: import('data/LikesStore.js').LikesStore,
   * }} opts
   */
  constructor({ feedEl, bootEl, bus, viewport, virtualizer, feedService, playback, likes }) {
    this.#feedEl = feedEl;
    this.#bootEl = bootEl;
    this.#bus = bus;
    this.#viewport = viewport;
    this.#virtualizer = virtualizer;
    this.#feed = feedService;
    this.#playback = playback;
    this.#likes = likes;
  }

  async start() {
    this.#offs.push(this.#bus.on('slide:enter', (p) => this.#onSlideEnter(p)));
    this.#offs.push(this.#bus.on('feed:page', () => this.#onPageLoaded()));
    this.#offs.push(this.#bus.on('feed:error', (p) => this.#onPageError(p)));
    this.#offs.push(this.#bus.on('intent', (i) => this.#onIntent(i)));
    this.#offs.push(this.#bus.on('mute:changed', (m) => this.#onMuteChanged(m)));
    // Cells appended after boot (a growing feed) must join the observer too;
    // the boot-time grid is observed directly below once the IO exists.
    this.#offs.push(
      this.#bus.on('cells:added', ({ cells }) => {
        for (const cell of cells) {
          this.#io?.observe(cell);
        }
      }),
    );

    const { total } = await this.#feed.init();
    this.#virtualizer.setTotal(total);

    this.#io = new IntersectionObserver(this.#onIntersect, {
      root: this.#feedEl,
      // A center-line band: exactly the slide crossing the vertical center reports
      // as intersecting. Fires on every boundary crossing, including during a fling.
      rootMargin: '-50% 0px -50% 0px',
      threshold: 0,
    });
    for (const cell of this.#virtualizer.cells) {
      this.#io.observe(cell);
    }

    this.#feedEl.addEventListener('scroll', this.#onScroll, { passive: true });
    if ('onscrollend' in window) {
      this.#feedEl.addEventListener('scrollend', this.#onScrollEnd, { passive: true });
    }
    document.addEventListener('visibilitychange', this.#onVisibility);
    window.addEventListener('pagehide', this.#onPageHide);

    this.#commit(0);
    this.#bootEl.hidden = true;
  }

  // ── Active-slide detection ────────────────────────────────────────────────
  /** @param {IntersectionObserverEntry[]} entries */
  #onIntersect = (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        this.#setCandidate(Number(/** @type {HTMLElement} */ (e.target).dataset.index));
      }
    }
    this.#armIdleSettle();
  };

  /** @param {number} index */
  #setCandidate(index) {
    if (index === this.#candidate) {
      return;
    }

    this.#candidate = index;
    this.#feed.ensureAround(index); // infinite scroll: fetch pages ahead
    this.#virtualizer.update(index); // window follows the scroll (posters bridge)

    if (index === this.#activeIndex) {
      return;
    }

    if (Math.abs(index - this.#activeIndex) > 1) {
      // Crossed more than a neighbor without settling — a fling. Drop all
      // decoders and let posters bridge; settle acquires one at the destination.
      this.#playback.suspend();
    } else {
      this.#playback.pause(); // one step: stop outgoing audio, keep decoder warm
    }
  }

  #onScroll = () => this.#armIdleSettle();

  // Cancel the idle backstop: without this, the timer fires ~140ms after the
  // scrollend settle and re-commits the same index (tearing down and rewiring
  // the already-playing video for nothing).
  #onScrollEnd = () => {
    clearTimeout(this.#idleTimer);
    this.#settle();
  };

  /**
   * Settle when the scroll goes quiet. Armed on every scroll as the reliable path;
   * `scrollend` (when supported) just makes it snappier. Both are needed because
   * `scrollend` does not fire for programmatic/instant scrolls in every engine.
   */
  #armIdleSettle() {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = window.setTimeout(() => this.#settle(), 140);
  }

  // Commit from MEASURED geometry, not the last IO nomination: during a snap
  // re-adjustment Chrome can report a spurious neighboring cell, and trusting
  // it would briefly commit the wrong index (dropping user state like an
  // explicit pause). One scrollTop read on the settle path is our documented
  // exception — this is exactly what it exists for.
  #settle = () => {
    this.#commit(
      indexFromScroll(this.#feedEl.scrollTop, this.#viewport.height, this.#virtualizer.total),
    );
  };

  /**
   * Commit `index` as the active slide: mount the window and start playback.
   * @param {number} index
   */
  #commit(index) {
    // Warm the neighbor the viewer is moving TOWARD: scrolling up must warm
    // index-1, not blindly index+1 (a warm decoder behind the viewer is wasted).
    this.#direction = index >= this.#activeIndex ? 1 : -1;
    this.#navTarget = null; // the keyboard-nav chain (if any) has landed
    this.#candidate = index;
    this.#activeIndex = index;
    this.#feed.ensureAround(index);
    this.#virtualizer.update(index);
    this.#playback.setActive(index, this.#direction);
  }

  // ── Data binding ──────────────────────────────────────────────────────────
  /**
   * The mounted SlideView at `index`, or null when it's outside the window.
   * The Virtualizer is deliberately view-agnostic, so its generic `Slide` is
   * widened to the concrete SlideView in this one place.
   * @param {number} index
   * @returns {import('view/SlideView.js').SlideView | null}
   */
  #slideAt(index) {
    return /** @type {any} */ (this.#virtualizer.getSlide(index));
  }

  /**
   * Bind `item` into a mounted slide with the current global state applied —
   * the single place binding happens, so the mute icon can never be forgotten.
   * @param {any} slide
   * @param {import('data/FeedService.js').FeedItem} item
   * @param {number} index
   */
  #bindSlide(slide, item, index) {
    slide.bind(item, index);
    slide.setMuted(this.#playback.muted);
  }

  /** @param {import('app/events.js').AppEvents['slide:enter']} p */
  #onSlideEnter({ slide, index }) {
    const item = this.#feed.getItem(index);
    if (item) {
      this.#bindSlide(slide, item, index);
    } else {
      slide.bindPending(index);
      this.#feed.ensureAround(index);
    }
  }

  #onPageLoaded() {
    // Fill in any mounted slide that was waiting on this page's data.
    let activeWasPending = false;
    this.#virtualizer.eachMounted((slide, index) => {
      if (!slide.item) {
        const item = this.#feed.getItem(index);
        if (item) {
          this.#bindSlide(slide, item, index);
          activeWasPending ||= index === this.#activeIndex;
        }
      }
    });

    // Re-commit only when the ACTIVE slide just received its data — prefetched
    // pages arriving must not tear down and rewire a video that's already
    // playing. The candidate check also keeps a page that resolves MID-FLING
    // from starting playback behind the viewer's back (our no-decoding-in-
    // flight invariant); the fling's own settle will commit the real target.
    if (activeWasPending && this.#candidate === this.#activeIndex) {
      this.#playback.setActive(this.#activeIndex, this.#direction);
    }
  }

  /** @param {import('app/events.js').AppEvents['feed:error']} p */
  #onPageError({ page }) {
    this.#virtualizer.eachMounted((slide, index) => {
      if (!slide.item && this.#feed.pageOf(index) === page) {
        slide.showError(true);
      }
    });
  }

  // ── Intents ───────────────────────────────────────────────────────────────
  /** @param {import('app/events.js').AppEvents['intent']} i */
  #onIntent(i) {
    switch (i.type) {
      case 'like':
        this.#like(i.index ?? this.#activeIndex, i.gesture === 'double-tap');
        break;
      case 'mute':
        this.#playback.toggleMute();
        break;
      case 'toggle-play':
        // A tap commits one DOUBLE_TAP_MS later (see GestureController) — drop
        // it if the user has already scrolled away. Keyboard sends no index.
        if (i.index === undefined || i.index === this.#activeIndex) {
          this.#playback.togglePlay();
        }
        break;
      case 'retry':
        this.#retry(i.index ?? this.#activeIndex);
        break;
      case 'nav':
        this.#navigate(i.delta ?? 0);
        break;
      // 'comment' / 'share' are UI stubs for this task.
    }
  }

  /**
   * The like button toggles; a double-tap only ever *likes* (never un-likes) and
   * always shows the heart burst — matching the TikTok/Reels convention.
   * @param {number} index @param {boolean} doubleTap
   */
  #like(index, doubleTap) {
    const item = this.#feed.getItem(index);

    if (!item) {
      return;
    }

    let liked;

    if (doubleTap) {
      liked = true;
      if (!this.#likes.isLiked(item.id)) {
        this.#likes.toggle(item.id);
      }
    } else {
      liked = this.#likes.toggle(item.id);
    }
    const slide = this.#slideAt(index);
    slide?.setLiked(liked, this.#likes.displayCount(item));

    if (doubleTap) {
      slide?.burstLike();
    }
  }

  /**
   * Retry after an error. Two distinct failure modes end in the same button:
   * a failed manifest *page* (the slide has no item yet) → re-fetch the page;
   * a failed *video* on the active slide → rebind and replay it.
   * @param {number} index
   */
  #retry(index) {
    const item = this.#feed.getItem(index);

    if (!item) {
      const slide = this.#slideAt(index);
      slide?.showError(false);
      slide?.showSpinner(true);
      // Failed pages are never cached, so this re-requests; `feed:page` rebinds.
      void this.#feed.loadPage(this.#feed.pageOf(index));
      return;
    }

    if (index === this.#activeIndex) {
      this.#playback.reload(index);
    }
  }

  /** @param {number} delta */
  #navigate(delta) {
    // Accumulate from the PENDING target, not the settled index: rapid key
    // presses each advance one more slide. Without this, presses arriving
    // mid-glide all recompute from the same stale base and 15 presses move
    // the feed by two slides. The chain resets on settle (#commit).
    const base = this.#navTarget ?? this.#candidate;
    this.#navTarget = clamp(base + delta, 0, this.#virtualizer.total - 1);
    // Scroll to the exact index → native snap finishes → IO + settle play it.
    // Users who asked the OS for reduced motion get an instant jump, not a glide.
    this.#feedEl.scrollTo({
      top: scrollTopFor(this.#navTarget, this.#viewport.height),
      behavior: REDUCED_MOTION.matches ? 'auto' : 'smooth',
    });
  }

  /** @param {boolean} muted */
  #onMuteChanged(muted) {
    this.#virtualizer.eachMounted((slide) => slide.setMuted(muted));
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  #onVisibility = () => {
    if (document.hidden) {
      this.#playback.onHidden();
    } else {
      this.#commit(this.#activeIndex);
    }
  };

  // Only park the decoders — never tear the app down here. The page may go into
  // the bfcache and be restored by back-navigation; `visibilitychange` will then
  // re-commit the active slide. Real teardown lives in the composition root.
  #onPageHide = () => this.#playback.onHidden();

  /** Detach everything THIS controller wired. Module teardown is main.js's job. */
  destroy() {
    for (const off of this.#offs) {
      off();
    }
    this.#offs = [];
    clearTimeout(this.#idleTimer);
    this.#io?.disconnect();
    this.#feedEl.removeEventListener('scroll', this.#onScroll);
    this.#feedEl.removeEventListener('scrollend', this.#onScrollEnd);
    document.removeEventListener('visibilitychange', this.#onVisibility);
    window.removeEventListener('pagehide', this.#onPageHide);
  }
}
