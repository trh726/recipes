import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecipeCache } from '../public/recipe-cache.mjs';

test('hover and navigation share an in-flight request', async () => {
  let calls = 0;
  let finish;
  const cache = createRecipeCache(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  cache.prefetch('a');
  const opened = cache.get('a');
  await Promise.resolve();
  finish({ id: 'a' });
  assert.deepEqual(await opened, { id: 'a' });
  assert.equal(calls, 1);
});

test('completed requests defer to the browser HTTP cache without another memory TTL', async () => {
  let revision = 0;
  const cache = createRecipeCache(async () => ++revision);
  assert.equal(await cache.get('a'), 1);
  assert.equal(await cache.get('a'), 2);
});

test('failed prefetch does not poison the cache or create an unhandled rejection', async () => {
  let calls = 0;
  const cache = createRecipeCache(async () => { if (++calls === 1) throw new Error('offline'); return 'recipe'; });
  cache.prefetch('a');
  await assert.rejects(cache.get('a'), /offline/);
  assert.equal(await cache.get('a'), 'recipe');
});

test('limits speculative requests but allows an explicit navigation', async () => {
  const calls = [];
  const finishes = [];
  const cache = createRecipeCache(id => { calls.push(id); return new Promise(resolve => finishes.push(resolve)); });
  cache.prefetch('a');
  cache.prefetch('b');
  cache.prefetch('c');
  const navigation = cache.get('c');
  await Promise.resolve();
  assert.deepEqual(calls, ['a', 'b', 'c']);
  finishes.forEach(resolve => resolve('recipe'));
  await navigation;
});
