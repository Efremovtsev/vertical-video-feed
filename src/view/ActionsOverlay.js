// @ts-check

const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)');

/** @param {number} n compact count, e.g. 12345 → "12.3K" */
function compact(n) {
  if (n < 1000) {
    return String(n);
  }

  if (n < 1_000_000) {
    return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  }

  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * The meta + action rail inside one slide: author, caption, like/comment/share/mute
 * buttons, and the double-tap heart burst. It only renders — click handling is
 * delegated on the feed root (see GestureController), so recycled nodes never leak
 * per-node listeners.
 */
export class ActionsOverlay {
  #likes;
  #author;
  #caption;
  #likeBtn;
  #likeCount;
  #muteIcon;
  #heart;

  /**
   * @param {HTMLElement} slideEl
   * @param {import('data/LikesStore.js').LikesStore} likesStore
   */
  constructor(slideEl, likesStore) {
    this.#likes = likesStore;
    this.#author = /** @type {HTMLElement} */ (slideEl.querySelector('.slide__author'));
    this.#caption = /** @type {HTMLElement} */ (slideEl.querySelector('.slide__caption'));
    this.#likeBtn = /** @type {HTMLElement} */ (slideEl.querySelector('[data-action="like"]'));
    this.#likeCount = /** @type {HTMLElement} */ (
      slideEl.querySelector('[data-role="like-count"]')
    );
    this.#muteIcon = /** @type {HTMLElement} */ (slideEl.querySelector('[data-role="mute-icon"]'));
    this.#heart = /** @type {HTMLElement} */ (slideEl.querySelector('.slide__heart'));
  }

  /** @param {import('data/FeedService.js').FeedItem} item */
  bind(item) {
    this.#author.textContent = item.author;
    this.#caption.textContent = item.caption;
    this.setLiked(this.#likes.isLiked(item.id), this.#likes.displayCount(item));
  }

  /** @param {boolean} liked @param {number} count */
  setLiked(liked, count) {
    this.#likeBtn.setAttribute('aria-pressed', String(liked));
    this.#likeCount.textContent = compact(count);
  }

  /** @param {boolean} muted */
  setMuteIcon(muted) {
    this.#muteIcon.textContent = muted ? '🔇' : '🔊';
  }

  /**
   * Fire the heart-burst animation (Web Animations API → compositor, no reflow).
   * The keyframes live HERE and only here — don't re-add a CSS copy. Purely
   * decorative, so reduced-motion users get no motion at all.
   */
  burst() {
    if (REDUCED_MOTION.matches) {
      return;
    }

    this.#heart.animate(
      [
        { opacity: 0, transform: 'translate(-50%, -50%) scale(0.3)' },
        { opacity: 1, transform: 'translate(-50%, -50%) scale(1.15)', offset: 0.15 },
        { opacity: 1, transform: 'translate(-50%, -55%) scale(1)', offset: 0.7 },
        { opacity: 0, transform: 'translate(-50%, -70%) scale(0.9)' },
      ],
      { duration: 700, easing: 'ease-out' },
    );
  }
}
