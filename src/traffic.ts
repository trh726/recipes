import type { Env } from "./types";

/** Protect public data work; static files and authenticated MCP remain separate. */
export async function limitPublicTraffic(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const collection = ["/", "/recipes", "/recipes/", "/api/recipes"].includes(url.pathname);
  const dataRoute = collection || url.pathname === "/api/tags" ||
    /^\/(?:api\/)?recipes\/[^/]+\/?$/.test(url.pathname);
  if (!dataRoute) return null;
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const reject = (status: number) => new Response(
    status === 429 ? "Too many requests. Please try again in a minute." : "Temporarily unavailable. Please try again in a minute.",
    { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "retry-after": "60" } },
  );
  try {
    if (env.PUBLIC_RATE_LIMITER && !(await env.PUBLIC_RATE_LIMITER.limit({ key: `recipes:read:${ip}` })).success) {
      return reject(429);
    }
    if (collection && url.searchParams.get("q")?.trim() && env.SEARCH_RATE_LIMITER &&
        !(await env.SEARCH_RATE_LIMITER.limit({ key: `recipes:search:${ip}` })).success) {
      return reject(429);
    }
  } catch {
    // Avoid unbounded database/AI work if a configured limiter is unavailable.
    return reject(503);
  }
  return null;
}
