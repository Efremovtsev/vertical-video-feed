// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FEED_DIR,
  INDEX_FILE,
  PAGE_FILE_RE,
  pageCount,
  pageFileName,
} from '../src/data/manifest.js';

describe('manifest layout contract', () => {
  it('pins the directory and index names the producer and consumer share', () => {
    assert.equal(FEED_DIR, 'public/feed');
    assert.equal(INDEX_FILE, 'index.json');
  });

  it('pads page numbers to three digits', () => {
    assert.equal(pageFileName(0), 'page-000.json');
    assert.equal(pageFileName(7), 'page-007.json');
    assert.equal(pageFileName(123), 'page-123.json');
  });

  it('does not truncate page numbers beyond three digits', () => {
    assert.equal(pageFileName(1234), 'page-1234.json');
  });

  it('generated names always match the cleanup pattern (producer/consumer lockstep)', () => {
    for (const page of [0, 7, 42, 999, 1234]) {
      assert.ok(PAGE_FILE_RE.test(pageFileName(page)));
    }
  });

  it('the cleanup pattern rejects near-misses', () => {
    assert.ok(!PAGE_FILE_RE.test('page-.json'));
    assert.ok(!PAGE_FILE_RE.test('xpage-000.json'));
    assert.ok(!PAGE_FILE_RE.test('page-000.json.bak'));
    assert.ok(!PAGE_FILE_RE.test('index.json'));
  });

  it('computes page counts like the producer paginates', () => {
    assert.equal(pageCount(11, 8), 2);
    assert.equal(pageCount(16, 8), 2);
    assert.equal(pageCount(17, 8), 3);
    assert.equal(pageCount(1, 8), 1);
    assert.equal(pageCount(0, 8), 0);
  });
});
