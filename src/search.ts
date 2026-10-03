import { getRecipeSummaries, searchRecipes } from "./db";
import type { Env, Recipe, RecipeSummary } from "./types";
import { errorFields, log } from "./log";

// Keep the model, pooling, dimensions, and index in sync when changing these.
export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
export const EMBEDDING_DIMENSIONS = 768;
export const MAX_QUERY_LENGTH = 500;
const MIN_SIMILARITY = 0.55;
const SEARCH_TIMEOUT_MS = 4000;

export interface SearchResult {
  recipes: RecipeSummary[];
  search: { mode: "hybrid" | "keyword"; degraded: boolean };
}

export interface SearchSource {
  keyword(query: string, limit: number, tags: string[]): Promise<RecipeSummary[]>;
  summaries(ids: string[], tags: string[]): Promise<RecipeSummary[]>;
}

/** Compact recipe text puts title, tags, and ingredients before longer prose. */
export function recipeSearchText(recipe: Recipe): string {
  return [
    recipe.title.slice(0, 160),
    `Tags: ${recipe.tags.join(", ").slice(0, 160)}`,
    recipe.description.slice(0, 300),
    `Ingredients: ${recipe.ingredients.join("; ").slice(0, 600)}`,
    `Time: ${(recipe.prep_time_minutes ?? 0) + (recipe.cook_time_minutes ?? 0)} minutes`,
    recipe.notes.slice(0, 150),
    recipe.instructions.join(" ").slice(0, 250),
  ].join("\n");
}

export async function embedTexts(ai: Ai, text: string[]): Promise<number[][]> {
  const result = await ai.run(EMBEDDING_MODEL, { text, pooling: "cls" });
  if (!("data" in result) || !Array.isArray(result.data) || result.data.length !== text.length ||
      result.data.some(vector => !Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS ||
        vector.some(value => !Number.isFinite(value)))) {
    throw new Error("Invalid embedding response");
  }
  return result.data;
}

/** Weighted reciprocal-rank fusion preserves exact matches and deduplicates. */
export function mergeSearchResults(keyword: RecipeSummary[], semantic: RecipeSummary[], limit: number): RecipeSummary[] {
  const ranked = new Map<string, { recipe: RecipeSummary; score: number }>();
  for (const [list, weight] of [[keyword, 1.5], [semantic, 1]] as const) {
    list.forEach((recipe, index) => {
      const entry = ranked.get(recipe.id) ?? { recipe, score: 0 };
      entry.score += weight / (60 + index + 1);
      ranked.set(recipe.id, entry);
    });
  }
  return [...ranked.values()].sort((a, b) => b.score - a.score).slice(0, limit).map(entry => entry.recipe);
}

async function queryEmbedding(env: Env, query: string): Promise<number[]> {
  // Cache only query embeddings, never recipe results: edits/deletes remain fresh.
  const normalized = query.toLowerCase().replace(/\s+/g, " ");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const key = new Request(`https://recipe-search.invalid/bge-base-cls-v1/${hash}`);
  const cache = typeof caches === "undefined" ? undefined : caches.default;
  try {
    const hit = await cache?.match(key);
    if (hit) return await hit.json<number[]>();
  } catch { /* Cache failures must not prevent search. */ }
  const [vector] = await embedTexts(env.AI!, [`Represent this sentence for searching relevant passages: ${normalized}`]);
  try {
    await cache?.put(key, new Response(JSON.stringify(vector), {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=86400" },
    }));
  } catch { /* An uncached embedding is still usable. */ }
  return vector;
}

async function semanticRecipes(env: Env, query: string, tags: string[], source: SearchSource): Promise<RecipeSummary[]> {
  const vector = await queryEmbedding(env, query);
  const result = await env.RECIPE_VECTORS!.query(vector, {
    topK: 50, returnValues: false, returnMetadata: "all",
  });
  const matches = result.matches.filter(match => match.score >= MIN_SIMILARITY);
  const recipes = new Map((await source.summaries(matches.map(match => match.id), tags))
    .map(recipe => [recipe.id, recipe]));
  return matches.flatMap(match => {
    const recipe = recipes.get(match.id);
    // A changed recipe must wait for its new embedding; keyword search is immediate.
    return recipe && match.metadata?.updated_at === recipe.updated_at ? [recipe] : [];
  });
}

export async function hybridSearch(env: Env, rawQuery: string, requestedLimit = 25, tags: string[] = [], source: SearchSource = {
  keyword: (query, limit, tags) => searchRecipes(env.DB, query, limit, tags),
  summaries: (ids, tags) => getRecipeSummaries(env.DB, ids, tags),
}): Promise<SearchResult> {
  const query = rawQuery.trim();
  if (query.length > MAX_QUERY_LENGTH) throw new RangeError(`Search is limited to ${MAX_QUERY_LENGTH} characters.`);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(100, Math.trunc(requestedLimit))) : 25;
  if (!/[\p{L}\p{N}]/u.test(query)) return { recipes: [], search: { mode: "keyword", degraded: false } };
  const keyword = source.keyword(query, 100, tags);
  if (!env.AI || !env.RECIPE_VECTORS || query.length < 3) {
    return { recipes: (await keyword).slice(0, limit), search: { mode: "keyword", degraded: false } };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const semantic = Promise.race([
    semanticRecipes(env, query, tags, source),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Search timeout")), SEARCH_TIMEOUT_MS); }),
  ]).then(recipes => ({ recipes, degraded: false })).catch(error => {
    log("warn", "semantic_search_degraded", errorFields(error));
    return { recipes: [] as RecipeSummary[], degraded: true };
  }).finally(() => { if (timer !== undefined) clearTimeout(timer); });
  const [keywords, meanings] = await Promise.all([keyword, semantic]);
  return {
    recipes: mergeSearchResults(keywords, meanings.recipes, limit),
    search: { mode: meanings.degraded ? "keyword" : "hybrid", degraded: meanings.degraded },
  };
}
