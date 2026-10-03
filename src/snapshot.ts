import { normalizeTags, readRecipeCatalog } from "./db";
import type { Env, Recipe, RecipeSummary } from "./types";
import type { SearchSource } from "./search";

export interface RecipeCatalog {
  revision: number;
  publishedAt: string;
  recipes: Recipe[];
}

/** One serialized publisher and a persisted JSON snapshot; public GETs never read D1. */
export class RecipeSnapshot {
  private document: string | undefined;
  private revision = 0;

  constructor(private state: DurableObjectState, private env: Env) {
    const sql = state.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS catalog (id INTEGER PRIMARY KEY, document TEXT NOT NULL)");
    const saved = sql.exec<{ document: string }>("SELECT document FROM catalog WHERE id = 1").toArray()[0];
    if (saved) {
      this.document = saved.document;
      this.revision = (JSON.parse(saved.document) as RecipeCatalog).revision;
    }
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/refresh") {
      // Serialize cron and all MCP sessions. An older refresh cannot overwrite
      // a newer snapshot. A failed write leaves the prior document intact.
      return this.state.blockConcurrencyWhile(async () => {
        try {
          const current = await this.env.DB.prepare("SELECT revision FROM recipe_publication WHERE id = 1")
            .first<{ revision: number }>();
          if (!current) throw new Error("Recipe snapshot migration is missing");
          if (current.revision === this.revision && this.document) {
            return Response.json({ changed: false, revision: this.revision });
          }
          const data = await readRecipeCatalog(this.env.DB);
          const catalog: RecipeCatalog = { ...data, publishedAt: new Date().toISOString() };
          const document = JSON.stringify(catalog);
          const bytes = new TextEncoder().encode(document).byteLength;
          if (bytes > 1024 * 1024) {
            throw new Error("Recipe snapshot exceeds the 1 MiB safety limit");
          }
          this.state.storage.sql.exec("INSERT OR REPLACE INTO catalog(id, document) VALUES (1, ?)", document);
          this.document = document;
          this.revision = catalog.revision;
          console.log({ event: "recipe_snapshot_published", revision: catalog.revision, recipes: catalog.recipes.length, bytes });
          return Response.json({ changed: true, revision: catalog.revision, recipes: catalog.recipes.length });
        } catch (error) {
          console.error({ event: "recipe_snapshot_failed", message: error instanceof Error ? error.message : "Unknown error" });
          return Response.json({ error: "Snapshot refresh failed; the previous snapshot is preserved." }, { status: 503 });
        }
      });
    }
    if (request.method !== "GET" || path !== "/catalog") return new Response("Not found", { status: 404 });
    if (!this.document) return new Response("Recipe snapshot has not been published yet.", { status: 503 });
    return new Response(this.document, {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=60" },
    });
  }
}

/** Called after successful edits and by cron. Publication failure never undoes a saved recipe. */
export async function refreshRecipeSnapshot(env: Env): Promise<boolean> {
  if (!env.RECIPE_SNAPSHOT) return true;
  try {
    const result = await env.RECIPE_SNAPSHOT.getByName("catalog").fetch("https://snapshot/refresh", { method: "POST" });
    if (result.ok) return true;
  } catch { /* A later scheduled refresh retries from the D1 revision. */ }
  console.error({ event: "recipe_snapshot_refresh_pending" });
  return false;
}

export async function loadRecipeCatalog(env: Env, origin: string): Promise<RecipeCatalog> {
  if (!env.RECIPE_SNAPSHOT) throw new Error("Recipe snapshot binding is missing");
  const key = new Request(new URL("/__recipe_catalog_v1", origin));
  const cache = typeof caches === "undefined" ? undefined : caches.default;
  try {
    const hit = await cache?.match(key);
    if (hit) {
      const catalog = await hit.json<RecipeCatalog>();
      if (Math.random() < 0.01) console.log({ event: "recipe_snapshot_read", source: "edge", sampleRate: 0.01, revision: catalog.revision });
      return catalog;
    }
  } catch { /* Fall back to the persisted snapshot, never to D1. */ }
  const response = await env.RECIPE_SNAPSHOT.getByName("catalog").fetch("https://snapshot/catalog");
  if (!response.ok) throw new Error("Recipe snapshot is unavailable");
  const catalog = await response.clone().json<RecipeCatalog>();
  console.log({ event: "recipe_snapshot_read", source: "durable", sampleRate: 1, revision: catalog.revision });
  try { await cache?.put(key, response); } catch { /* Snapshot remains usable. */ }
  return catalog;
}

function summary(recipe: Recipe): RecipeSummary {
  const { id, title, description, tags, servings, prep_time_minutes, cook_time_minutes, image_url, updated_at } = recipe;
  return { id, title, description, tags, servings, prep_time_minutes, cook_time_minutes, image_url, updated_at };
}

function hasTags(recipe: Recipe, tags: string[]): boolean {
  return tags.every(tag => recipe.tags.includes(tag));
}

export function catalogList(catalog: RecipeCatalog, tags: string[], limit = 50, offset = 0) {
  const matches = catalog.recipes.filter(recipe => hasTags(recipe, normalizeTags(tags)));
  return { recipes: matches.slice(offset, offset + limit).map(summary), total: matches.length };
}

export function catalogTags(catalog: RecipeCatalog): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  catalog.recipes.forEach(recipe => recipe.tags.forEach(tag => counts.set(tag, (counts.get(tag) ?? 0) + 1)));
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

function words(text: string): string[] {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Prefix/AND keyword matching over a small static catalog, without a SQL query. */
export function catalogSearchSource(catalog: RecipeCatalog): SearchSource {
  return {
    async keyword(query, limit, tags) {
      const tokens = words(query);
      if (!tokens.length) return [];
      return catalog.recipes.filter(recipe => hasTags(recipe, normalizeTags(tags))).map(recipe => {
        const title = words(recipe.title);
        const content = words([recipe.title, recipe.description, ...recipe.ingredients, ...recipe.instructions, ...recipe.tags, recipe.notes].join(" "));
        const matches = tokens.every(token => content.some(word => word.startsWith(token)));
        const score = tokens.reduce((sum, token) => sum + (title.some(word => word.startsWith(token)) ? 3 : 1), 0);
        return { recipe, matches, score };
      }).filter(result => result.matches).sort((a, b) => b.score - a.score).slice(0, limit).map(result => summary(result.recipe));
    },
    async summaries(ids, tags) {
      const selected = new Set(ids);
      return catalog.recipes.filter(recipe => selected.has(recipe.id) && hasTags(recipe, normalizeTags(tags))).map(summary);
    },
  };
}
