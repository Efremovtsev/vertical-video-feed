// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  clamp,
  computeWindow,
  indexFromScroll,
  scrollTopFor,
} from '../src/engine/WindowCalculator.js';

describe('clamp', () => {
  it('passes values inside the range through', () => {
    assert.equal(clamp(5, 0, 10), 5);
  });

  it('clamps below and above', () => {
    assert.equal(clamp(-3, 0, 10), 0);
    assert.equal(clamp(42, 0, 10), 10);
  });
});

describe('scrollTopFor', () => {
  it('is the exact snap offset for an index', () => {
    assert.equal(scrollTopFor(0, 813), 0);
    assert.equal(scrollTopFor(5, 813), 4065);
  });
});

describe('indexFromScroll (the settle-path ground truth)', () => {
  it('rounds to the nearest slide', () => {
    assert.equal(indexFromScroll(0, 813, 11), 0);
    assert.equal(indexFromScroll(4065, 813, 11), 5);
    assert.equal(indexFromScroll(4065 + 12, 813, 11), 5); // a nudge stays on the slide
    assert.equal(indexFromScroll(4065 + 407, 813, 11), 6); // past halfway → next
  });

  it('clamps to the feed bounds and survives degenerate inputs', () => {
    assert.equal(indexFromScroll(999999, 813, 11), 10);
    assert.equal(indexFromScroll(-50, 813, 11), 0);
    assert.equal(indexFromScroll(500, 0, 11), 0); // H not measured yet
    assert.equal(indexFromScroll(500, 813, 0), 0); // empty feed
  });
});

describe('computeWindow', () => {
  it('centers the window on the active index', () => {
    const w = computeWindow({ activeIndex: 10, total: 100, poolSize: 9 });
    assert.deepEqual(w, { start: 6, end: 14 });
  });

  it('clamps at the start of the feed but keeps the pool fully used', () => {
    const w = computeWindow({ activeIndex: 0, total: 100, poolSize: 9 });
    assert.deepEqual(w, { start: 0, end: 8 });
  });

  it('clamps at the end of the feed but keeps the pool fully used', () => {
    const w = computeWindow({ activeIndex: 99, total: 100, poolSize: 9 });
    assert.deepEqual(w, { start: 91, end: 99 });
  });

  it('shrinks to the feed when it is smaller than the pool', () => {
    const w = computeWindow({ activeIndex: 3, total: 5, poolSize: 9 });
    assert.deepEqual(w, { start: 0, end: 4 });
  });

  it('yields an empty range (end < start) for an empty feed', () => {
    const w = computeWindow({ activeIndex: 0, total: 0, poolSize: 9 });
    assert.ok(w.end < w.start);
  });

  it('handles an even pool size without gaps', () => {
    const w = computeWindow({ activeIndex: 10, total: 100, poolSize: 8 });
    assert.equal(w.end - w.start + 1, 8);
    assert.ok(w.start <= 10 && 10 <= w.end);
  });
});
