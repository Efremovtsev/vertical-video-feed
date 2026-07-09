// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EventBus } from '../src/core/EventBus.js';

describe('EventBus', () => {
  it('delivers the payload to a subscriber', () => {
    const bus = new EventBus();
    /** @type {unknown[]} */
    const seen = [];
    bus.on('ping', (p) => seen.push(p));
    bus.emit('ping', 42);
    assert.deepEqual(seen, [42]);
  });

  it('delivers to every subscriber of the type, and only that type', () => {
    const bus = new EventBus();
    let a = 0;
    let b = 0;
    let other = 0;
    bus.on('t', () => a++);
    bus.on('t', () => b++);
    bus.on('unrelated', () => other++);
    bus.emit('t');
    assert.deepEqual([a, b, other], [1, 1, 0]);
  });

  it('off() and the returned unsubscribe both stop delivery', () => {
    const bus = new EventBus();
    let viaOff = 0;
    let viaUnsub = 0;
    const handler = () => viaOff++;
    bus.on('t', handler);
    const unsub = bus.on('t', () => viaUnsub++);
    bus.off('t', handler);
    unsub();
    bus.emit('t');
    assert.deepEqual([viaOff, viaUnsub], [0, 0]);
  });

  it('a handler may unsubscribe itself during dispatch without breaking others', () => {
    const bus = new EventBus();
    let first = 0;
    let second = 0;
    const unsub = bus.on('t', () => {
      first++;
      unsub();
    });
    bus.on('t', () => second++);
    bus.emit('t');
    bus.emit('t');
    assert.equal(first, 1); // ran once, then removed itself
    assert.equal(second, 2); // unaffected both times
  });

  it('emitting with no subscribers is a no-op', () => {
    const bus = new EventBus();
    assert.doesNotThrow(() => bus.emit('nobody-listens', { x: 1 }));
  });
});
