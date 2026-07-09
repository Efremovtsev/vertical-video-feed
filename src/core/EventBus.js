// @ts-check

/**
 * Tiny typed publish/subscribe hub. It is the ONLY coupling between feature
 * modules — nothing in `engine/`, `media/`, `view/`, or `data/` imports another
 * feature module directly. That keeps every unit independently testable and lets
 * `FeedController` be the single place that understands the whole lifecycle.
 *
 * @template {Record<string, any>} [Events=Record<string, any>]
 */
export class EventBus {
  /** @type {Map<string, Set<(payload: any) => void>>} */
  #listeners = new Map();

  /**
   * Subscribe to an event. Returns an unsubscribe function.
   * @template {keyof Events & string} K
   * @param {K} type
   * @param {(payload: Events[K]) => void} handler
   * @returns {() => void}
   */
  on(type, handler) {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(handler);
    return () => this.off(type, handler);
  }

  /**
   * @template {keyof Events & string} K
   * @param {K} type
   * @param {(payload: Events[K]) => void} handler
   */
  off(type, handler) {
    this.#listeners.get(type)?.delete(handler);
  }

  /**
   * Emit an event to all current subscribers. Iterating the live Set is safe:
   * JS Set iteration tolerates deletion mid-loop, so a handler may unsubscribe
   * itself (or others) during dispatch without a defensive copy per emit.
   * @template {keyof Events & string} K
   * @param {K} type
   * @param {Events[K]} [payload]
   */
  emit(type, payload) {
    const set = this.#listeners.get(type);

    if (!set) {
      return;
    }

    for (const handler of set) {
      handler(payload);
    }
  }
}
