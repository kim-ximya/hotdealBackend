import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleColumns } from '../desktop/article-list.js';

const keys = (requested) => visibleColumns(requested).map(([key]) => key);

test('shows only the chosen columns, even when title is hidden', () => {
  assert.deepEqual(keys(['title']), ['title']);
  assert.deepEqual(keys(['author']), ['author']);
  assert.deepEqual(keys(['price', 'title']), ['title', 'price']);
  assert.deepEqual(keys(['thumbnailUrl', 'store', 'shipping']), ['thumbnailUrl', 'store', 'shipping']);
});

test('New is independent of title and has no redundant column when both are shown', () => {
  assert.deepEqual(keys(['isNew']), ['isNew']);
  assert.deepEqual(keys(['isNew', 'title', 'price']), ['title', 'price']);
});

test('unavailable saved columns fall back to a valid default and duplicates are ignored', () => {
  assert.deepEqual(keys(['obsolete']), keys(null));
  assert.deepEqual(keys(['author', 'author', 'obsolete']), ['author']);
  assert.ok(keys([]).includes('price'));
});
