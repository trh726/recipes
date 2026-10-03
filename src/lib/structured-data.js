import { recipeImage } from './presentation.js';

const nutritionFields = [
  ['calories', 'calories', 'calories'],
  ['protein_g', 'proteinContent', 'g'],
  ['fat_g', 'fatContent', 'g'],
  ['saturated_fat_g', 'saturatedFatContent', 'g'],
  ['carbohydrates_g', 'carbohydrateContent', 'g'],
  ['fiber_g', 'fiberContent', 'g'],
  ['sugar_g', 'sugarContent', 'g'],
  ['sodium_mg', 'sodiumContent', 'mg'],
];

/** Do not mistake item counts, cup measures, or ranges for a serving count. */
function servingCount(yieldText) {
  const match = /^(\d+)(?:\s+servings?)?(?:\s+\([^)]*\))?$/i.exec(yieldText)
    ?? /\((\d+)\s+servings?\)$/i.exec(yieldText);
  const count = Number(match?.[1]);
  return Number.isSafeInteger(count) && count > 0 ? String(count) : undefined;
}

/**
 * Describe the saved recipe already rendered by the page; this performs no I/O.
 * @param {import('../types').Recipe} recipe
 * @param {URL | string} site
 * @returns {Record<string, unknown>}
 */
export function recipeStructuredData(recipe, site) {
  const url = new URL(`/recipes/${encodeURIComponent(recipe.id)}`, site).href;
  const image = recipeImage(recipe).url;
  const yieldText = recipe.servings.trim();
  const servings = servingCount(yieldText);
  const data = {
    '@context': 'https://schema.org',
    '@type': 'Recipe',
    '@id': `${url}#recipe`,
    url,
    mainEntityOfPage: url,
    name: recipe.title,
    ...(recipe.description.trim() && { description: recipe.description }),
    ...(image && { image: [new URL(image, site).href] }),
    recipeIngredient: recipe.ingredients,
    recipeInstructions: recipe.instructions.map((text, index) => ({
      '@type': 'HowToStep', text, url: `${url}#step-${index + 1}`,
    })),
    ...(yieldText && { recipeYield: servings && servings !== yieldText ? [servings, yieldText] : yieldText }),
  };

  // Google expects prep and cook times together. Unknown is not zero; do not
  // infer totalTime because the recipe may also include resting or curing time.
  const times = [recipe.prep_time_minutes, recipe.cook_time_minutes];
  if (times.every(value => Number.isSafeInteger(value) && value >= 0)) {
    data.prepTime = `PT${recipe.prep_time_minutes}M`;
    data.cookTime = `PT${recipe.cook_time_minutes}M`;
  }

  // Per-serving nutrition needs an unambiguous number of servings for Google.
  if (servings && recipe.nutrition) {
    const values = Object.fromEntries(nutritionFields.flatMap(([key, property, unit]) => {
      const value = recipe.nutrition[key];
      return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? [[property, `${value} ${unit}`]] : [];
    }));
    if (Object.keys(values).length) data.nutrition = {
      '@type': 'NutritionInformation',
      servingSize: recipe.nutrition.serving_size || '1 serving',
      ...values,
    };
  }
  return data;
}

/** Safe for an inline JSON-LD script, including recipe text containing </script>. */
export function serializeJsonLd(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
