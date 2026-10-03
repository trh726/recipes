import test from 'node:test';
import assert from 'node:assert/strict';
import { scaleLine, parseServings } from '../src/lib/scaling.js';

test('ingredient scaling preserves fractions, ranges, and package sizes', () => {
  assert.equal(scaleLine('1 1/2 cups flour', 2), '3 cups flour');
  assert.equal(scaleLine('½ tsp salt', 0.5), '¼ tsp salt');
  assert.equal(scaleLine('2–3 carrots', 2), '4–6 carrots');
  assert.equal(scaleLine('1 can (400g) tomatoes', 2), '2 can (400g) tomatoes');
  assert.equal(scaleLine('Salt to taste', 2), 'Salt to taste');
  assert.equal(scaleLine('1 1/2 cups flour', 1), '1 1/2 cups flour');
});

test('serving controls distinguish numeric servings from multiplier-only recipes', () => {
  assert.equal(parseServings('4–6 servings'), 4);
  assert.equal(parseServings('One batch'), null);
  assert.equal(parseServings(''), null);
});
