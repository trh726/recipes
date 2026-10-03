// Only public, read-only API representations belong in this cache. MCP reads
// and writes bypass it. A hit must happen BEFORE D1, including during SSR.
const TTL_SECONDS = 60;
const STORED_AT = "x-recipe-stored-at";

function clientResponse(response: Response, request: Request, hit: boolean): Response {
  const headers = new Headers(response.headers);
  const storedAt = Number(headers.get(STORED_AT));
  if (storedAt) {
    const age = Math.max(0, Math.floor((Date.now() - storedAt) / 1000));
    headers.set("cache-control", `private, max-age=${Math.max(0, TTL_SECONDS - age)}, must-revalidate`);
    headers.delete(STORED_AT);
  }
  headers.set("x-recipe-cache", hit ? "HIT" : "MISS");
  const etag = headers.get("etag");
  const unchanged = response.status === 200 && etag && request.headers.get("if-none-match")?.split(",").some(value => {
    const tag = value.trim().replace(/^W\//, "");
    return tag === "*" || tag === etag;
  });
  return new Response(unchanged ? null : response.body, {
    status: unchanged ? 304 : response.status,
    headers,
  });
}

export async function publicCachedResponse(
  request: Request,
  canonicalUrl: URL,
  load: () => Promise<Response>,
): Promise<Response> {
  const cache = typeof caches === "undefined" ? undefined : caches.default;
  // Separate internal representations from directly requested HTTP resources.
  const keyUrl = new URL(canonicalUrl);
  keyUrl.pathname = `/__recipe_data_v1${keyUrl.pathname}`;
  const key = new Request(keyUrl);
  try {
    const hit = await cache?.match(key);
    if (hit) return clientResponse(hit, request, true);
  } catch { /* Cache availability must not take the site offline. */ }

  const response = await load();
  if (response.status !== 200 || response.headers.get("cache-control")?.includes("no-store")) {
    return response;
  }
  const stored = new Response(response.body, response);
  stored.headers.set(STORED_AT, String(Date.now()));
  stored.headers.set("cache-control", `public, max-age=${TTL_SECONDS}`);
  try {
    // Await the small cache write so the very next request can reuse it.
    await cache?.put(key, stored.clone());
  } catch { /* A successful read remains usable if caching fails. */ }
  return clientResponse(stored, request, false);
}
