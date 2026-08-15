# 🍲 Recipe Box

A personal recipe manager with an unusual editor: **Claude**. Recipes are created, updated, and organized by Claude in chat via a remote [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server, and browsed through a fast, searchable web frontend — all running on a single Cloudflare Worker.

> *"Claude, save that curry recipe you just wrote to my recipe box."* → it's on your recipes site seconds later, full-text searchable, tagged, and formatted for cooking from.

## How it works

```
┌─────────────┐   MCP over Streamable HTTP    ┌──────────────────────────────┐
│  claude.ai   │ ────────────────────────────► │   Cloudflare Worker           │
│  (connector) │      /mcp/<secret>            │                               │
└─────────────┘                                │  ┌────────────────────────┐  │
                                               │  │ McpAgent (Durable Obj) │  │
┌─────────────┐    GET /api/recipes?q=...      │  │ 7 recipe CRUD tools    │  │
│   Browser    │ ────────────────────────────► │  └───────────┬────────────┘  │
│  (frontend)  │ ◄──────────────────────────── │  ┌───────────▼────────────┐  │
└─────────────┘    static assets + JSON        │  │ D1 (SQLite) + FTS5     │  │
                                               │  └────────────────────────┘  │
                                               └──────────────────────────────┘
```

One Worker serves three surfaces:

| Route | Surface | Who uses it |
|---|---|---|
| `/mcp` (or `/mcp/<secret>`) | Remote MCP server (Streamable HTTP) | Claude — claude.ai connectors, Claude Code, Claude Desktop |
| `/api/*` | Read-only JSON API | The frontend |
| everything else | Static single-page app | You, in a browser |

**Design decision — writes only go through MCP.** The web API is deliberately read-only, so the public HTTP surface needs no auth story: the browser UI is for searching and cooking, while all mutations flow through the MCP endpoint, which is protected by an unguessable URL (see [Security](#security)).

## Features

**MCP server** (what Claude can do):
- `create_recipe` / `update_recipe` / `delete_recipe` — full CRUD with schema-validated inputs
- `search_recipes` — ranked full-text search (SQLite FTS5) across titles, ingredients, instructions, tags, and notes, with prefix matching (`tomat` finds `tomatoes`)
- `list_recipes` / `get_recipe` / `list_tags` — browsing and pagination

**Frontend**:
- Instant full-text search and tag filtering
- Cook-friendly detail view: ingredient checkboxes, numbered steps, prep/cook times
- No framework, no build step — vanilla JS/CSS, light & dark theme, fully responsive

**Infrastructure**:
- [Cloudflare Workers](https://developers.cloudflare.com/workers/) — compute + static assets
- [D1](https://developers.cloudflare.com/d1/) — serverless SQLite with an FTS5 index kept in sync by triggers
- [Durable Objects](https://developers.cloudflare.com/durable-objects/) — MCP session state (via Cloudflare's [`agents`](https://developers.cloudflare.com/agents/) SDK)

Everything fits comfortably in Cloudflare's free tier.

## Project structure

```
├── src/
│   ├── index.ts      # Worker entry: routes /mcp, /api/*, and static assets
│   ├── mcp.ts        # McpAgent subclass — the 7 MCP tools
│   ├── api.ts        # Read-only REST endpoints for the frontend
│   ├── db.ts         # D1 data access: CRUD, FTS query building, tag counts
│   └── types.ts      # Shared types (Env bindings, Recipe shapes)
├── public/           # Frontend (served as static assets, no build step)
│   ├── index.html
│   ├── app.js        # Hash-routed SPA: list/search view + detail view
│   └── styles.css
├── schema.sql        # Tables, FTS5 index, sync triggers
├── migrations/       # Incremental ALTERs for databases created from older schemas
├── seed.sql          # Optional sample recipes
└── wrangler.jsonc    # Worker config: D1, Durable Object, assets bindings
```

## Setup

### Prerequisites

- Node.js 20+
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is fine)

### 1. Install & authenticate

```sh
npm install
npx wrangler login
```

### 2. Create the database

```sh
npx wrangler d1 create recipes-db
```

Copy the `database_id` from the output into `wrangler.jsonc` (replacing `YOUR_D1_DATABASE_ID`), then apply the schema:

```sh
npm run db:migrate        # remote (production) database
npm run db:seed           # optional: two sample recipes
```

> Already created your database from an older schema? Apply the incremental files in `migrations/` instead of re-running `schema.sql` — each file notes the command to run.

### 3. Protect the MCP endpoint (recommended)

```sh
npx wrangler secret put MCP_SECRET
# paste a long random value, e.g. from: openssl rand -hex 24
```

With the secret set, the MCP server answers only at `/mcp/<secret>` and the bare `/mcp` path returns 401. Without it, `/mcp` is open to anyone who finds the URL.

### 4. Deploy

```sh
npm run deploy
```

Wrangler prints your Worker URL, e.g. `https://recipes.<your-subdomain>.workers.dev`. The frontend is live at that URL immediately.

## Connecting Claude

### claude.ai (web & mobile) — custom connector

1. **Settings → Connectors → Add custom connector**
2. Name it (e.g. "Recipe Box") and set the URL to:
   ```
   https://recipes.<your-subdomain>.workers.dev/mcp/<your-secret>
   ```
3. Add — no OAuth configuration needed.

Then just talk to Claude: *"Generate a weeknight pasta recipe and save it to my recipe box"*, *"What do I have tagged 'dessert'?"*, *"Update the chickpea curry — I doubled the garlic and it was better."*

### Claude Code

```sh
claude mcp add --transport http recipe-box https://recipes.<your-subdomain>.workers.dev/mcp/<your-secret>
```

### Claude Desktop (via mcp-remote)

```json
{
  "mcpServers": {
    "recipe-box": {
      "command": "npx",
      "args": ["mcp-remote", "https://recipes.<your-subdomain>.workers.dev/mcp/<your-secret>"]
    }
  }
}
```

## MCP tools reference

| Tool | Arguments | Description |
|---|---|---|
| `list_recipes` | `limit?`, `offset?`, `tag?` | Newest-first summaries, optional tag filter |
| `search_recipes` | `query`, `limit?` | Ranked FTS5 search with prefix matching |
| `get_recipe` | `id` | One recipe in full |
| `create_recipe` | `title`, `ingredients[]`, `instructions[]`, `description?`, `tags?[]`, `servings?`, `prep_time_minutes?`, `cook_time_minutes?`, `source?`, `notes?`, `image_url?`, `nutrition?` | Save a new recipe; returns it with its generated id |
| `update_recipe` | `id` + any create fields | Partial update; provided array fields replace in full; `nutrition: null` clears saved nutrition |

`nutrition` is an object of optional per-serving values modeled on [schema.org/NutritionInformation](https://schema.org/NutritionInformation), flattened to numbers: `serving_size`, `calories`, `protein_g`, `fat_g`, `saturated_fat_g`, `carbohydrates_g`, `fiber_g`, `sugar_g`, `sodium_mg`. `image_url` is an HTTPS photo URL (the frontend renders only `http(s)` URLs).
| `delete_recipe` | `id` | Permanent delete |
| `list_tags` | — | All tags with usage counts |

## Web API reference

All endpoints are `GET`-only and return JSON.

| Endpoint | Query params | Returns |
|---|---|---|
| `/api/recipes` | `q` (search), `tag`, `limit`, `offset` | `{ recipes: RecipeSummary[], total }` |
| `/api/recipes/:id` | — | Full recipe or 404 |
| `/api/tags` | — | `{ tags: [{ tag, count }] }` |

## Local development

```sh
cp .dev.vars.example .dev.vars   # optionally set MCP_SECRET for local testing
npm run db:migrate:local          # schema into the local D1 emulator
npm run db:seed:local             # optional sample data
npm run dev                       # http://localhost:8787
```

- Frontend: http://localhost:8787
- API: http://localhost:8787/api/recipes
- MCP: http://localhost:8787/mcp — test it with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):
  ```sh
  npx @modelcontextprotocol/inspector
  # connect with transport "Streamable HTTP" to http://localhost:8787/mcp
  ```

Type-check with `npm run check`.

## Security

- **No credentials in the repo.** The D1 `database_id` in `wrangler.jsonc` is committed, but D1 ids are resource identifiers, not secrets — access requires your Cloudflare account. The MCP secret lives in Worker secrets (`wrangler secret put`) and locally in the git-ignored `.dev.vars`.
- **MCP endpoint protection** uses a capability URL (`/mcp/<secret>`) rather than OAuth, because claude.ai custom connectors can send a URL but not custom headers. The secret only ever travels over HTTPS. For a single-user personal app this is a reasonable trade-off; if you need real multi-user auth, Cloudflare's [`workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) drops into the same `McpAgent` setup.
- **The write path is not exposed over plain HTTP.** `POST/PUT/DELETE` on `/api/*` return 405; mutations exist only as MCP tools behind the secret URL.
- **SQL is fully parameterized** and FTS query input is tokenized/quoted before it reaches `MATCH`, so neither SQL nor FTS5 syntax injection is possible.

## Possible extensions

- OAuth (e.g. GitHub login) on the MCP endpoint via `workers-oauth-provider`
- Image *uploads* for finished dishes (R2 behind the existing `image_url` field)
- A "cooked it" log with dates and ratings, so Claude can answer *"what did I make last month?"*
- Meal-plan and shopping-list tools composed from existing recipes

## License

[MIT](./LICENSE)
