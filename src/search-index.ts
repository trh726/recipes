import { getRecipe } from "./db";
import { embedTexts, recipeSearchText } from "./search";
import type { Env, Recipe } from "./types";
import { errorFields, log } from "./log";

interface IndexJob { recipe_id: string; revision: string }

/** Drain the durable D1 outbox. Triggers enqueue saves, edits, and deletions. */
export async function syncSearchIndex(env: Env): Promise<void> {
  if (!env.AI || !env.RECIPE_VECTORS) return;
  const lease = crypto.randomUUID();
  // Atomic leases prevent overlapping cron runs from indexing the same recipe.
  // A crashed run becomes retryable after ten minutes.
  const claimed = await env.DB.prepare(`
    UPDATE recipe_search_jobs SET lease_token = ?, lease_until = unixepoch() + 600
    WHERE recipe_id IN (
      SELECT recipe_id FROM recipe_search_jobs
      WHERE lease_until < unixepoch() AND next_attempt <= unixepoch()
      ORDER BY next_attempt, recipe_id LIMIT 20
    ) RETURNING recipe_id, revision
  `).bind(lease).all<IndexJob>();
  const jobs = claimed.results ?? [];
  if (!jobs.length) return;

  try {
    const recipes = (await Promise.all(jobs.map(job => getRecipe(env.DB, job.recipe_id))))
      .filter((recipe): recipe is Recipe => recipe !== null);
    const present = new Set(recipes.map(recipe => recipe.id));
    const deleted = jobs.filter(job => !present.has(job.recipe_id)).map(job => job.recipe_id);
    if (recipes.length) {
      const vectors = await embedTexts(env.AI, recipes.map(recipeSearchText));
      await env.RECIPE_VECTORS.upsert(recipes.map((recipe, index) => ({
        id: recipe.id, values: vectors[index], metadata: { updated_at: recipe.updated_at },
      })));
    }
    if (deleted.length) await env.RECIPE_VECTORS.deleteByIds(deleted);

    // If a recipe changed while embedding, its new revision stays queued.
    await env.DB.batch([
      ...jobs.map(job => env.DB.prepare(`
        DELETE FROM recipe_search_jobs WHERE recipe_id = ? AND revision = ? AND lease_token = ?
      `).bind(job.recipe_id, job.revision, lease)),
      env.DB.prepare(`UPDATE recipe_search_jobs SET lease_token = NULL, lease_until = 0 WHERE lease_token = ?`).bind(lease),
    ]);
    log("log", "search_index_synced", { recipes: recipes.length, deletions: deleted.length });
  } catch (error) {
    await env.DB.prepare(`
      UPDATE recipe_search_jobs SET lease_token = NULL, lease_until = 0, next_attempt = unixepoch() + 300
      WHERE lease_token = ?
    `).bind(lease).run();
    log("error", "search_index_failed", { jobs: jobs.length, ...errorFields(error) });
    throw error;
  }
}
