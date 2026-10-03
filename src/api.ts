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
import { errorFields, log } from "./log";
import { getRecipe, listRecipes, listTags, normalizeTags } from "./db";
import { hybridSearch, MAX_QUERY_LENGTH } from "./search";
import { publicCachedResponse } from "./public-cache";
import { loadRecipeCatalog, catalogList, catalogTags, catalogSearchSource } from "./snapshot";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function cacheableJson(payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const etag = `"${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}"`;
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, max-age=60, must-revalidate",
    etag,
  };
  return new Response(body, { headers });
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

  // Ignore tracking/sort parameters and normalize equivalent filters so crawlers
  // cannot force fresh D1 reads just by permuting the same URL parameters.
  const canonical = new URL(path, url.origin);
  if (path === "/api/recipes") {
    const q = url.searchParams.get("q")?.trim();
    if (q && q.length > MAX_QUERY_LENGTH) return json({ error: `Search is limited to ${MAX_QUERY_LENGTH} characters.` }, 400);
    const tags = normalizeTags(url.searchParams.getAll("tag")).sort();
    if (tags.length > 10 || tags.some(tag => tag.length > 100)) return json({ error: "Too many or overly long tags." }, 400);
    if (q) canonical.searchParams.set("q", q);
    tags.forEach(tag => canonical.searchParams.append("tag", tag));
    const limit = intParam(url.searchParams, "limit");
    canonical.searchParams.set("limit", String(Number.isFinite(limit) ? Math.max(1, Math.min(100, limit!)) : q ? 25 : 50));
    if (!q) {
      const offset = intParam(url.searchParams, "offset") ?? 0;
      if (!Number.isSafeInteger(offset) || offset > 10000) return json({ error: "Offset must be at most 10000." }, 400);
      canonical.searchParams.set("offset", String(Math.max(0, offset)));
    }
  } else if (path !== "/api/tags" && !/^\/api\/recipes\/[A-Za-z0-9_-]+$/.test(path)) {
    return json({ error: "Not found" }, 404);
  }
  // A single cached catalog serves every filter combination. Do not layer the
  // per-URL cache on top: that would compound snapshot staleness.
  if (env.RECIPE_SNAPSHOT) return handleSnapshotApi(request, canonical, env);
  return publicCachedResponse(request, canonical, () => handleUncachedApi(new Request(canonical), env));
}

async function handleSnapshotApi(request: Request, url: URL, env: Env): Promise<Response> {
  try {
    const catalog = await loadRecipeCatalog(env, url.origin);
    const tags = url.searchParams.getAll("tag");
    let response: Response;
    if (url.pathname === "/api/tags") response = await cacheableJson({ tags: catalogTags(catalog) });
    else if (url.pathname === "/api/recipes") {
      const q = url.searchParams.get("q");
      const limit = intParam(url.searchParams, "limit");
      if (q) {
        const result = await hybridSearch(env, q, limit, tags, catalogSearchSource(catalog));
        response = result.search.degraded ? json({ ...result, total: result.recipes.length, query: q }) :
          await cacheableJson({ ...result, total: result.recipes.length, query: q });
      } else response = await cacheableJson(catalogList(catalog, tags, limit, intParam(url.searchParams, "offset")));
    } else {
      const id = url.pathname.split("/").pop();
      const recipe = catalog.recipes.find(recipe => recipe.id === id);
      if (!recipe) return json({ error: "Recipe not found" }, 404);
      response = await cacheableJson(recipe);
    }
    // Only the catalog owns a TTL; browser revalidation must not add another minute.
    if (!response.headers.get("cache-control")?.includes("no-store")) {
      response.headers.set("cache-control", "private, no-cache");
    }
    response.headers.set("x-recipe-data-source", "snapshot");
    response.headers.set("x-recipe-revision", String(catalog.revision));
    response.headers.set("x-recipe-published-at", catalog.publishedAt);
    const etag = response.headers.get("etag");
    const unchanged = etag && request.headers.get("if-none-match")?.split(",").some(value => {
      const tag = value.trim().replace(/^W\//, "");
      return tag === etag || tag === "*";
    });
    return unchanged ? new Response(null, { status: 304, headers: response.headers }) : response;
  } catch (error) {
    log("error", "recipe_snapshot_read_failed", errorFields(error));
    return json({ error: "Recipes are temporarily unavailable. Please try again shortly." }, 503);
  }
}

async function handleUncachedApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  try {
    if (path === "/api/recipes") {
      const q = url.searchParams.get("q")?.trim();
      const tags = url.searchParams.getAll("tag");
      const limit = intParam(url.searchParams, "limit");
      const offset = intParam(url.searchParams, "offset");

      if (q) {
        const result = await hybridSearch(env, q, limit, tags);
        const payload = { ...result, total: result.recipes.length, query: q };
        return result.search.degraded ? json(payload) : cacheableJson(payload);
      }
      const result = await listRecipes(env.DB, { limit, offset, tags });
      return cacheableJson(result);
    }

    const recipeMatch = path.match(/^\/api\/recipes\/([A-Za-z0-9_-]+)$/);
    if (recipeMatch) {
      const recipe = await getRecipe(env.DB, recipeMatch[1]);
      if (!recipe) return json({ error: "Recipe not found" }, 404);
      return cacheableJson(recipe);
    }

    if (path === "/api/tags") {
      const tags = await listTags(env.DB);
      return cacheableJson({ tags });
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    log("error", "api_failed", errorFields(err));
    return json({ error: "Internal error" }, 500);
  }
}
