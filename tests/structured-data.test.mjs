import test from 'node:test';
import assert from 'node:assert/strict';
import { recipeStructuredData, serializeJsonLd } from '../src/lib/structured-data.js';

const site = 'https://recipes.example.com';
const recipe = {
  id: 'test-recipe', title: 'A recipe', description: 'A saved description.',
  ingredients: ['1 cup beans', 'Salt to taste'], instructions: ['Soak.', 'Cook.'],
  servings: '4 servings', prep_time_minutes: 10, cook_time_minutes: 90,
  tags: [], image_url: 'https://images.example.com/beans.jpg',
  nutrition: { calories: 250, protein_g: 12, sodium_mg: 0, serving_size: '1 bowl' },
};

test('schema describes the displayed recipe with absolute image and step URLs', () => {
  const data = recipeStructuredData(recipe, site);
  assert.equal(data['@type'], 'Recipe');
  assert.equal(data.name, recipe.title);
  assert.deepEqual(data.recipeIngredient, recipe.ingredients);
  assert.deepEqual(data.recipeInstructions, [
    { '@type': 'HowToStep', text: 'Soak.', url: `${site}/recipes/test-recipe#step-1` },
    { '@type': 'HowToStep', text: 'Cook.', url: `${site}/recipes/test-recipe#step-2` },
  ]);
  assert.deepEqual(data.image, [recipe.image_url]);
  assert.equal(data.prepTime, 'PT10M');
  assert.equal(data.cookTime, 'PT90M');
  assert.ok(!('totalTime' in data), 'resting time is not known');
  assert.deepEqual(data.recipeYield, ['4', '4 servings']);
  assert.deepEqual(data.nutrition, {
    '@type': 'NutritionInformation', servingSize: '1 bowl',
    calories: '250 calories', proteinContent: '12 g', sodiumContent: '0 mg',
  });
  const illustrated = recipeStructuredData({ ...recipe, id: 'rcp_389811526b', image_url: '' }, site);
  assert.deepEqual(illustrated.image, [`${site}/illustrations/wild-boar-chestnut-pithivier.png`]);
});

test('unknown data is omitted and yields do not invent per-serving nutrition', () => {
  const data = recipeStructuredData({
    ...recipe, description: '', image_url: 'javascript:alert(1)',
    prep_time_minutes: null, cook_time_minutes: 20, servings: '', nutrition: null,
  }, site);
  for (const property of ['description', 'image', 'prepTime', 'cookTime', 'totalTime', 'recipeYield', 'nutrition', 'author', 'aggregateRating']) {
    assert.ok(!(property in data), `${property} is not invented`);
  }
  for (const servings of ['12 cookies', 'About 3 cups', '4–6 servings', '8-12 servings', 'One batch', '0']) {
    const result = recipeStructuredData({ ...recipe, servings }, site);
    assert.equal(result.recipeYield, servings);
    assert.ok(!('nutrition' in result), servings);
  }
  for (const [servings, count] of [['4 servings (8 kofta)', '4'], ['About 1 cup (8 servings)', '8'], ['4 servings (as a side)', '4']]) {
    const result = recipeStructuredData({ ...recipe, servings }, site);
    assert.deepEqual(result.recipeYield, [count, servings]);
    assert.ok(result.nutrition);
  }
  const zero = recipeStructuredData({ ...recipe, prep_time_minutes: 0, cook_time_minutes: 0 }, site);
  assert.equal(zero.prepTime, 'PT0M');
  assert.equal(zero.cookTime, 'PT0M');
});

test('recipe text cannot escape the JSON-LD script and round-trips unchanged', () => {
  const dangerous = '</ScRiPt><script>alert("recipe")</script>&\u2028\u2029';
  const data = recipeStructuredData({ ...recipe, title: dangerous, instructions: [dangerous] }, site);
  const serialized = serializeJsonLd(data);
  assert.doesNotMatch(serialized, /[<>&\u2028\u2029]/);
  assert.deepEqual(JSON.parse(serialized), data);
});
