// Structured events for Workers Logs. Never log request paths or query strings:
// the MCP URL carries its secret, and search text is visitor input.
type Level = "log" | "warn" | "error";

export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  console[level]({ event, ...fields });
}

export function errorFields(error: unknown): { error: string; message: string } {
  return error instanceof Error
    ? { error: error.name, message: error.message }
    : { error: "unknown", message: String(error) };
}

// Sample successful requests to keep crawler bursts inside the daily log
// allowance; server errors are always logged. Divide counts by sampleRate.
const REQUEST_SAMPLE_RATE = 0.25;

export type RouteKind = "mcp" | "api" | "search" | "collection" | "detail" | "other";

export function routeKind(url: URL): RouteKind {
  const path = url.pathname;
  if (path === "/mcp" || path.startsWith("/mcp/")) return "mcp";
  if (path === "/api" || path.startsWith("/api/")) return "api";
  if (["/", "/recipes", "/recipes/"].includes(path)) {
    return url.searchParams.get("q")?.trim() ? "search" : "collection";
  }
  if (/^\/recipes\/[^/]+\/?$/.test(path)) return "detail";
  return "other";
}

export function logRequest(request: Request, url: URL, status: number, started: number, error?: unknown): void {
  const serverError = status >= 500;
  const sampleRate = serverError ? 1 : REQUEST_SAMPLE_RATE;
  if (sampleRate < 1 && Math.random() >= sampleRate) return;
  const cf = request.cf as { colo?: string; asn?: number } | undefined;
  log(serverError ? "error" : "log", "request", {
    route: routeKind(url),
    method: request.method,
    status,
    tags: url.searchParams.getAll("tag").length,
    search: Boolean(url.searchParams.get("q")?.trim()),
    colo: cf?.colo,
    asn: cf?.asn,
    ms: Date.now() - started,
    sampleRate,
    ...(error === undefined ? {} : errorFields(error)),
  });
}
