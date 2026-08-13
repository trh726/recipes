/**
 * Worker entry point — routes requests to one of three surfaces:
 *
 *   /mcp (or /mcp/<secret>)  Remote MCP server (Streamable HTTP) for Claude
 *   /api/*                   Read-only REST API for the frontend
 *   everything else          Static frontend from ./public
 *
 * The MCP endpoint can be protected with a shared secret because claude.ai
 * custom connectors take a URL but no custom headers: setting the MCP_SECRET
 * secret moves the endpoint to the unguessable path /mcp/<secret>, and the
 * bare /mcp path starts returning 401.
 */
import { RecipesMcpAgent } from "./mcp";
import { handleApi } from "./api";
import type { Env } from "./types";

export { RecipesMcpAgent };

const MCP_ROUTE = "/mcp";

// One handler instance, bound to the canonical /mcp path.
const mcpHandler = RecipesMcpAgent.serve(MCP_ROUTE, { binding: "MCP_OBJECT" });

function unauthorized(): Response {
  return new Response(
    JSON.stringify({ error: "Unauthorized. Use the /mcp/<secret> URL configured for this deployment." }),
    { status: 401, headers: { "content-type": "application/json; charset=utf-8" } }
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === MCP_ROUTE || path.startsWith(`${MCP_ROUTE}/`)) {
      const secret = env.MCP_SECRET?.trim();

      if (!secret) {
        // No secret configured: serve MCP at /mcp directly.
        return mcpHandler.fetch(request, env, ctx);
      }

      // Secret configured: only /mcp/<secret> is valid. Strip the secret
      // segment and forward to the handler at its canonical /mcp path.
      const expectedPrefix = `${MCP_ROUTE}/${secret}`;
      if (path === expectedPrefix || path.startsWith(`${expectedPrefix}/`)) {
        const rewritten = new URL(request.url);
        rewritten.pathname = MCP_ROUTE + path.slice(expectedPrefix.length);
        return mcpHandler.fetch(new Request(rewritten, request), env, ctx);
      }
      return unauthorized();
    }

    if (path === "/api" || path.startsWith("/api/")) {
      return handleApi(request, env);
    }

    // Static frontend (public/). Unmatched paths fall through to the assets
    // binding, which serves index.html and friends.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
