/**
 * Data access layer for recipes on Cloudflare D1.
 *
 * Array-valued fields (ingredients, instructions, tags) are stored as JSON
 * text columns; full-text search is served by the `recipes_fts` FTS5 table,
 * which triggers in schema.sql keep in sync with `recipes`.
 */
import type { Nutrition, Recipe, RecipeInput, RecipeSummary } from "./types";

/** Row shape as it comes back from D1 (JSON columns still serialized). */
interface RecipeRow {
  id: string;
  title: string;
  description: string;
  ingredients: string;
  instructions: string;
  tags: string;
  servings: string;
  prep_time_minutes: number | null;
  cook_time_minutes: number | null;
  source: string;
  notes: string;
  image_url: string;
  nutrition: string | null;
  created_at: string;
  updated_at: string;
}

const MAX_LIMIT = 100;

function parseJsonArray(text: string): string[] {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseNutrition(text: string | null): Nutrition | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Nutrition)
      : null;
  } catch {
    return null;
  }
}

/** Keep only known, valid nutrition fields; return null if nothing remains. */
function normalizeNutrition(nutrition: Nutrition | null | undefined): Nutrition | null {
  if (!nutrition) return null;
  const out: Nutrition = {};
  const servingSize = nutrition.serving_size?.trim();
  if (servingSize) out.serving_size = servingSize;
  const numericKeys = [
    "calories",
    "protein_g",
    "fat_g",
    "saturated_fat_g",
    "carbohydrates_g",
    "fiber_g",
    "sugar_g",
    "sodium_mg",
  ] as const;
  for (const key of numericKeys) {
    const value = nutrition[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function rowToRecipe(row: RecipeRow): Recipe {
  return {
    ...row,
    ingredients: parseJsonArray(row.ingredients),
    instructions: parseJsonArray(row.instructions),
    tags: parseJsonArray(row.tags),
    nutrition: parseNutrition(row.nutrition),
  };
}

function rowToSummary(row: RecipeRow): RecipeSummary {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    tags: parseJsonArray(row.tags),
    servings: row.servings,
    prep_time_minutes: row.prep_time_minutes,
    cook_time_minutes: row.cook_time_minutes,
    image_url: row.image_url,
    updated_at: row.updated_at,
  };
}

export function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const t = tag.trim().toLowerCase();
    if (t) seen.add(t);
  }
  return [...seen];
}

function newRecipeId(): string {
  // 10 hex chars of randomness — plenty for a personal recipe box.
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `rcp_${hex}`;
}

/**
 * Turn free text into a safe FTS5 prefix query.
 * "creamy garlic-pasta" -> `"creamy"* "garlic"* "pasta"*` (implicit AND).
 * Quoting each token neutralizes FTS5 operators in user input.
 */
function toFtsQuery(text: string): string | null {
  const tokens = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(" ");
}

function clampLimit(limit: number | undefined, fallback: number): number {
  if (!Number.isFinite(limit ?? NaN)) return fallback;
  return Math.min(Math.max(Math.trunc(limit as number), 1), MAX_LIMIT);
}

export async function createRecipe(db: D1Database, input: RecipeInput): Promise<Recipe> {
  const now = new Date().toISOString();
  const recipe: Recipe = {
    id: newRecipeId(),
    title: input.title.trim(),
    description: input.description?.trim() ?? "",
    ingredients: input.ingredients.map((s) => s.trim()).filter(Boolean),
    instructions: input.instructions.map((s) => s.trim()).filter(Boolean),
    tags: normalizeTags(input.tags),
    servings: input.servings?.trim() ?? "",
    prep_time_minutes: input.prep_time_minutes ?? null,
    cook_time_minutes: input.cook_time_minutes ?? null,
    source: input.source?.trim() ?? "",
    notes: input.notes?.trim() ?? "",
    image_url: input.image_url?.trim() ?? "",
    nutrition: normalizeNutrition(input.nutrition),
    created_at: now,
    updated_at: now,
  };

  await db
    .prepare(
      `INSERT INTO recipes
         (id, title, description, ingredients, instructions, tags, servings,
          prep_time_minutes, cook_time_minutes, source, notes, image_url,
          nutrition, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      recipe.id,
      recipe.title,
      recipe.description,
      JSON.stringify(recipe.ingredients),
      JSON.stringify(recipe.instructions),
      JSON.stringify(recipe.tags),
      recipe.servings,
      recipe.prep_time_minutes,
      recipe.cook_time_minutes,
      recipe.source,
      recipe.notes,
      recipe.image_url,
      recipe.nutrition ? JSON.stringify(recipe.nutrition) : null,
      recipe.created_at,
      recipe.updated_at
    )
    .run();

  return recipe;
}

export async function getRecipe(db: D1Database, id: string): Promise<Recipe | null> {
  const row = await db
    .prepare(`SELECT * FROM recipes WHERE id = ?`)
    .bind(id)
    .first<RecipeRow>();
  return row ? rowToRecipe(row) : null;
}

/** Read the complete catalog and its revision in one consistent D1 transaction. */
export async function readRecipeCatalog(db: D1Database): Promise<{ revision: number; recipes: Recipe[] }> {
  const [version, rows] = await db.batch([
    db.prepare("SELECT revision FROM recipe_publication WHERE id = 1"),
    db.prepare("SELECT * FROM recipes ORDER BY updated_at DESC, id ASC"),
  ]);
  const revision = (version.results[0] as { revision: number } | undefined)?.revision;
  if (revision === undefined) throw new Error("Recipe snapshot migration is missing");
  return { revision, recipes: (rows.results as unknown as RecipeRow[]).map(rowToRecipe) };
}

export async function listRecipes(
  db: D1Database,
  opts: { limit?: number; offset?: number; tag?: string; tags?: string[] } = {}
): Promise<{ recipes: RecipeSummary[]; total: number }> {
  const limit = clampLimit(opts.limit, 50);
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
  const tags = normalizeTags([...(opts.tags ?? []), ...(opts.tag ? [opts.tag] : [])]);
  // Without filters, COUNT(*) can use SQLite's fast count instead of visiting
  // every row to evaluate an empty JSON tag predicate.
  const where = tags.length ? `WHERE ${allTagsCondition}` : "";
  const tagPattern = tags.length ? [JSON.stringify(tags)] : [];

  const [rows, count] = await Promise.all([
    db
      .prepare(`SELECT * FROM recipes ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .bind(...tagPattern, limit, offset)
      .all<RecipeRow>(),
    db
      .prepare(`SELECT COUNT(*) AS n FROM recipes ${where}`)
      .bind(...tagPattern)
      .first<{ n: number }>(),
  ]);

  return {
    recipes: (rows.results ?? []).map(rowToSummary),
    total: count?.n ?? 0,
  };
}

// One bound JSON array, exact tag equality, and AND semantics (including zero tags).
const allTagsCondition = `NOT EXISTS (
  SELECT 1 FROM json_each(?) selected
  WHERE NOT EXISTS (SELECT 1 FROM json_each(recipes.tags) actual WHERE actual.value = selected.value)
)`;

export async function searchRecipes(
  db: D1Database,
  query: string,
  limit?: number,
  tags: string[] = []
): Promise<RecipeSummary[]> {
  const ftsQuery = toFtsQuery(query);
  if (!ftsQuery) return [];

  const rows = await db
    .prepare(
      `SELECT recipes.*
         FROM recipes_fts f
         JOIN recipes ON recipes.rowid = f.rowid
        WHERE recipes_fts MATCH ? AND ${allTagsCondition}
        ORDER BY f.rank
        LIMIT ?`
    )
    .bind(ftsQuery, JSON.stringify(normalizeTags(tags)), clampLimit(limit, 25))
    .all<RecipeRow>();

  return (rows.results ?? []).map(rowToSummary);
}

/** Hydrate vector matches from D1 so deleted recipes never appear in search. */
export async function getRecipeSummaries(db: D1Database, ids: string[], tags: string[] = []): Promise<RecipeSummary[]> {
  if (!ids.length) return [];
  const rows = await db.prepare(`SELECT * FROM recipes WHERE id IN (${ids.map(() => "?").join(",")}) AND ${allTagsCondition}`)
    .bind(...ids, JSON.stringify(normalizeTags(tags))).all<RecipeRow>();
  return (rows.results ?? []).map(rowToSummary);
}

export async function updateRecipe(
  db: D1Database,
  id: string,
  patch: Partial<RecipeInput>
): Promise<Recipe | null> {
  const existing = await getRecipe(db, id);
  if (!existing) return null;

  const updated: Recipe = {
    ...existing,
    title: patch.title !== undefined ? patch.title.trim() : existing.title,
    description: patch.description !== undefined ? patch.description.trim() : existing.description,
    ingredients:
      patch.ingredients !== undefined
        ? patch.ingredients.map((s) => s.trim()).filter(Boolean)
        : existing.ingredients,
    instructions:
      patch.instructions !== undefined
        ? patch.instructions.map((s) => s.trim()).filter(Boolean)
        : existing.instructions,
    tags: patch.tags !== undefined ? normalizeTags(patch.tags) : existing.tags,
    servings: patch.servings !== undefined ? patch.servings.trim() : existing.servings,
    prep_time_minutes:
      patch.prep_time_minutes !== undefined ? patch.prep_time_minutes : existing.prep_time_minutes,
    cook_time_minutes:
      patch.cook_time_minutes !== undefined ? patch.cook_time_minutes : existing.cook_time_minutes,
    source: patch.source !== undefined ? patch.source.trim() : existing.source,
    notes: patch.notes !== undefined ? patch.notes.trim() : existing.notes,
    image_url: patch.image_url !== undefined ? patch.image_url.trim() : existing.image_url,
    // `nutrition: null` clears saved nutrition; omitting the field keeps it.
    nutrition:
      patch.nutrition !== undefined ? normalizeNutrition(patch.nutrition) : existing.nutrition,
    updated_at: new Date().toISOString(),
  };

  await db
    .prepare(
      `UPDATE recipes SET
         title = ?, description = ?, ingredients = ?, instructions = ?, tags = ?,
         servings = ?, prep_time_minutes = ?, cook_time_minutes = ?, source = ?,
         notes = ?, image_url = ?, nutrition = ?, updated_at = ?
       WHERE id = ?`
    )
    .bind(
      updated.title,
      updated.description,
      JSON.stringify(updated.ingredients),
      JSON.stringify(updated.instructions),
      JSON.stringify(updated.tags),
      updated.servings,
      updated.prep_time_minutes,
      updated.cook_time_minutes,
      updated.source,
      updated.notes,
      updated.image_url,
      updated.nutrition ? JSON.stringify(updated.nutrition) : null,
      updated.updated_at,
      id
    )
    .run();

  return updated;
}

export async function deleteRecipe(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare(`DELETE FROM recipes WHERE id = ?`).bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}

/** Distinct tags with usage counts, for the frontend filter bar. */
export async function listTags(db: D1Database): Promise<{ tag: string; count: number }[]> {
  const rows = await db
    .prepare(
      `SELECT value AS tag, COUNT(*) AS count
         FROM recipes, json_each(recipes.tags)
        GROUP BY value
        ORDER BY count DESC, tag ASC`
    )
    .all<{ tag: string; count: number }>();
  return rows.results ?? [];
}
