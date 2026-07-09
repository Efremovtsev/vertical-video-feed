// @ts-check

/**
 * The app-wide event vocabulary — the ONE place payload shapes are declared.
 * Lives at the app level (not `core/`) because it references types from every
 * layer; `core/EventBus.js` stays generic and layer-agnostic.
 *
 * The composition root casts the bus to `AppBus` once; the mediator's `.on()`
 * call sites then get payload types inferred, so renaming a payload field fails
 * `tsc --checkJs` instead of silently breaking subscribers.
 *
 * @typedef {{
 *   'viewport:resize': number,
 *   'slide:enter': { slide: import('view/SlideView.js').SlideView, index: number },
 *   'cells:added': { cells: HTMLElement[] },
 *   'feed:page': { page: number, items: import('data/FeedService.js').FeedItem[] },
 *   'feed:error': { page: number, error: unknown },
 *   'intent': { type: string, index?: number, delta?: number, gesture?: string },
 *   'mute:changed': boolean,
 * }} AppEvents
 */

/** @typedef {import('core/EventBus.js').EventBus<AppEvents>} AppBus */

export {};
