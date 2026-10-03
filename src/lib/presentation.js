export function formatMinutes(mins) {
  if (mins === null || mins === undefined) return null;
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

export function totalTime(recipe) {
  const prep = recipe.prep_time_minutes ?? 0;
  const cook = recipe.cook_time_minutes ?? 0;
  const total = prep + cook;
  return total > 0 ? formatMinutes(total) : null;
}

/** Only http(s) URLs are ever rendered as images/links. */
export function safeUrl(url) {
  return /^https?:\/\//i.test(url ?? "") ? url : null;
}

// Approved illustrations, used until a recipe gets its own saved image.
const recipeIllustrations = {
  rcp_389811526b: "wild-boar-chestnut-pithivier",
  rcp_b0e190eecf: "cowboy-beans-bacon",
  rcp_c9a02d2149: "dill-heavy-tzatziki",
  rcp_891ff14671: "southwest-chicken-bowls",
  rcp_98a05ca97b: "cumberland-sauce",
  rcp_cab65fd09d: "cinghiale-ragu-chestnuts",
  rcp_b811eae16b: "sweet-potato-hash",
  rcp_4ea75ef3e5: "maple-rosemary-bacon",
  rcp_ea2579d88d: "dill-potato-salad",
  rcp_fc90b9657f: "lamb-pork-kofta",
  rcp_850ad2feca: "three-sisters-skillet-bowl",
  rcp_79324a51a6: "lemon-white-wine-pork-chops",
  rcp_b29d470b97: "fennel-apple-pancetta",
  rcp_486e93340b: "lemon-white-wine-pork-ribs",
  rcp_fc9689c36c: "apple-leek-pork-chops",
};

export function recipeImage(recipe) {
  const saved = safeUrl(recipe.image_url);
  const illustration = recipeIllustrations[recipe.id];
  return { url: saved || (illustration ? `/illustrations/${illustration}.png` : null), illustrated: !saved && !!illustration };
}

