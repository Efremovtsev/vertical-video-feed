// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LikesStore } from '../src/data/LikesStore.js';

// In Node there is no localStorage; the store's try/catch design means it must
// degrade to in-memory likes — which is exactly what private browsing does too.
describe('LikesStore (storage unavailable → in-memory)', () => {
  const item = { id: 'clip-1', likes: 100 };

  it('starts unliked', () => {
    const store = new LikesStore('test:likes');
    assert.equal(store.isLiked('clip-1'), false);
    assert.equal(store.displayCount(/** @type {any} */ (item)), 100);
  });

  it('toggle likes and unlikes, adjusting the displayed count by one', () => {
    const store = new LikesStore('test:likes');
    assert.equal(store.toggle('clip-1'), true);
    assert.equal(store.isLiked('clip-1'), true);
    assert.equal(store.displayCount(/** @type {any} */ (item)), 101);

    assert.equal(store.toggle('clip-1'), false);
    assert.equal(store.displayCount(/** @type {any} */ (item)), 100);
  });

  it('tracks ids independently', () => {
    const store = new LikesStore('test:likes');
    store.toggle('a');
    assert.equal(store.isLiked('a'), true);
    assert.equal(store.isLiked('b'), false);
  });
});
