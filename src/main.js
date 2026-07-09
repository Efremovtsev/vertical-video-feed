// @ts-check

import { FeedController } from 'app/FeedController.js';
import { EventBus } from 'core/EventBus.js';
import { RafScheduler } from 'core/RafScheduler.js';
import { Viewport } from 'core/viewport.js';
import { FeedService } from 'data/FeedService.js';
import { LikesStore } from 'data/LikesStore.js';
import { Virtualizer } from 'engine/Virtualizer.js';
import { GestureController } from 'input/GestureController.js';
import { KeyboardController } from 'input/KeyboardController.js';
import { PlaybackController } from 'media/PlaybackController.js';
import { VideoPool } from 'media/VideoPool.js';
import { SlideView } from 'view/SlideView.js';

/**
 * Composition root. Instantiates every module, injects dependencies, and starts
 * the feed. Contains no business logic — the wiring graph is meant to be readable
 * top to bottom.
 */

const POOL_SIZE = 9; // recycled slide nodes (cheap DOM). Window ≈ ±4 around active.
const DECODER_CAP = 2; // live <video> decoders: 1 active + 1 warm. See ARCHITECTURE §1.2.

const $ = (/** @type {string} */ sel) => {
  const el = document.querySelector(sel);

  if (!el) {
    throw new Error(`Missing required element: ${sel}`);
  }

  return /** @type {HTMLElement} */ (el);
};

const feedEl = $('#feed');
const cellsEl = $('#cells');
const slidesEl = $('#slides');
const bootEl = $('#boot');
const template = /** @type {HTMLTemplateElement} */ ($('#slide-template'));

// ── Core ──────────────────────────────────────────────────────────────────
// Typed once here; see src/events.js for the app-wide event vocabulary.
const bus = /** @type {import('app/events.js').AppBus} */ (new EventBus());
const scheduler = new RafScheduler();
const viewport = new Viewport(feedEl, bus);

// ── Data ──────────────────────────────────────────────────────────────────
const likes = new LikesStore();
const feedService = new FeedService({ bus });

// ── Engine ────────────────────────────────────────────────────────────────
const virtualizer = new Virtualizer({
  cellsEl,
  slidesEl,
  poolSize: POOL_SIZE,
  createSlide: () => new SlideView(template, likes),
  viewport,
  bus,
});

// ── Media ─────────────────────────────────────────────────────────────────
const pool = new VideoPool({ capacity: DECODER_CAP, muted: true });
const playback = new PlaybackController({
  pool,
  scheduler,
  bus,
  getItem: (index) => feedService.getItem(index),
  // Widen the Virtualizer's generic Slide to the PlayableSlide contract the
  // playback layer declares (SlideView satisfies it structurally).
  getSlide: (index) =>
    /** @type {import('media/PlaybackController.js').PlayableSlide | null} */ (
      /** @type {unknown} */ (virtualizer.getSlide(index))
    ),
});

// ── Input ─────────────────────────────────────────────────────────────────
const gestures = new GestureController({ root: feedEl, bus });
const keyboard = new KeyboardController({ bus });

// ── Orchestration ───────────────────────────────────────────────────────────
const feed = new FeedController({
  feedEl,
  bootEl,
  bus,
  viewport,
  virtualizer,
  feedService,
  playback,
  likes,
});

// Start in dependency order: measure the viewport first (so slide transforms have a
// real H), build the pool, wire input, then load data + render.
viewport.start();
virtualizer.start();
gestures.start();
keyboard.start();

feed.start().catch((err) => {
  console.error('[feed] failed to start:', err);
  bootEl.innerHTML =
    '<p style="padding:24px;text-align:center">Couldn\'t load the feed.<br>' +
    'Run <code>npm run build:feed</code> to generate <code>public/feed/</code>, then reload.</p>';
});

// Full teardown lives here — the composition root is the only owner of every
// module. A bfcache-persisted page must stay wired so back-navigation restores a
// working feed (FeedController parks the decoders on pagehide; that's enough).
window.addEventListener('pagehide', (e) => {
  if (e.persisted) {
    return;
  }

  feed.destroy();
  playback.destroy();
  virtualizer.destroy();
  viewport.destroy();
  gestures.destroy();
  keyboard.destroy();
  scheduler.destroy();
});
