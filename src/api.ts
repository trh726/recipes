/**
 * Read-only REST API consumed by the frontend.
 *
 * Writes go through the MCP server (Claude is the editor of this recipe box);
 * the web UI is for browsing and cooking from. Keeping the public HTTP surface
 * read-only means the frontend needs no auth story.
 *
 *   GET /api/recipes            list summaries   (?q= search, ?tag=, ?limit=, ?offset=)
 *   GET /api/recipes/:id        one full recipe
 *   GET /api/tags               tags with counts
 */
import type { Env } from "./types";
import { getRecipe, listRecipes, listTags, searchRecipes } from "./db";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function intParam(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);
  if (raw === null) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? undefined : n;
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method !== "GET") {
    return json({ error: "Method not allowed. The web API is read-only; edits go through MCP." }, 405);
  }

  try {
    if (path === "/api/recipes") {
      const q = url.searchParams.get("q")?.trim();
      const tag = url.searchParams.get("tag") ?? undefined;
      const limit = intParam(url.searchParams, "limit");
      const offset = intParam(url.searchParams, "offset");

      if (q) {
        const recipes = await searchRecipes(env.DB, q, limit);
        return json({ recipes, total: recipes.length, query: q });
      }
      const result = await listRecipes(env.DB, { limit, offset, tag });
      return json(result);
    }

    const recipeMatch = path.match(/^\/api\/recipes\/([A-Za-z0-9_-]+)$/);
    if (recipeMatch) {
      const recipe = await getRecipe(env.DB, recipeMatch[1]);
      if (!recipe) return json({ error: "Recipe not found" }, 404);
      return json(recipe);
    }

    if (path === "/api/tags") {
      const tags = await listTags(env.DB);
      return json({ tags });
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    console.error("API error:", err);
    return json({ error: "Internal error" }, 500);
  }
}
