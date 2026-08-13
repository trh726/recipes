/**
 * Data access layer for recipes on Cloudflare D1.
 *
 * Array-valued fields (ingredients, instructions, tags) are stored as JSON
 * text columns; full-text search is served by the `recipes_fts` FTS5 table,
 * which triggers in schema.sql keep in sync with `recipes`.
 */
import type { Recipe, RecipeInput, RecipeSummary } from "./types";

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

function rowToRecipe(row: RecipeRow): Recipe {
  return {
    ...row,
    ingredients: parseJsonArray(row.ingredients),
    instructions: parseJsonArray(row.instructions),
    tags: parseJsonArray(row.tags),
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
    updated_at: row.updated_at,
  };
}

function normalizeTags(tags: string[] | undefined): string[] {
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
    created_at: now,
    updated_at: now,
  };

  await db
    .prepare(
      `INSERT INTO recipes
         (id, title, description, ingredients, instructions, tags, servings,
          prep_time_minutes, cook_time_minutes, source, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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

export async function listRecipes(
  db: D1Database,
  opts: { limit?: number; offset?: number; tag?: string } = {}
): Promise<{ recipes: RecipeSummary[]; total: number }> {
  const limit = clampLimit(opts.limit, 50);
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
  const tag = opts.tag?.trim().toLowerCase();

  // Tags are stored as a JSON array of lowercase strings, so an exact-element
  // match is a LIKE on the serialized form: ["dinner","pasta"] contains "pasta".
  const where = tag ? `WHERE tags LIKE '%' || ? || '%'` : "";
  const tagPattern = tag ? [`"${tag.replaceAll('"', "")}"`] : [];

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

export async function searchRecipes(
  db: D1Database,
  query: string,
  limit?: number
): Promise<RecipeSummary[]> {
  const ftsQuery = toFtsQuery(query);
  if (!ftsQuery) return [];

  const rows = await db
    .prepare(
      `SELECT r.*
         FROM recipes_fts f
         JOIN recipes r ON r.rowid = f.rowid
        WHERE recipes_fts MATCH ?
        ORDER BY f.rank
        LIMIT ?`
    )
    .bind(ftsQuery, clampLimit(limit, 25))
    .all<RecipeRow>();

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
    updated_at: new Date().toISOString(),
  };

  await db
    .prepare(
      `UPDATE recipes SET
         title = ?, description = ?, ingredients = ?, instructions = ?, tags = ?,
         servings = ?, prep_time_minutes = ?, cook_time_minutes = ?, source = ?,
         notes = ?, updated_at = ?
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
