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
┌─────────────┐    GET /recipes?q=...          │  │ 7 recipe CRUD tools    │  │
│   Browser    │ ────────────────────────────► │  └───────────┬────────────┘  │
│  (frontend)  │ ◄──────────────────────────── │  ┌───────────▼────────────┐  │
└─────────────┘    server-rendered HTML         │  │ D1 (SQLite) + FTS5     │  │
                                               │  └────────────────────────┘  │
                                               └──────────────────────────────┘
```

One Worker serves three surfaces:

| Route | Surface | Who uses it |
|---|---|---|
| `/mcp` (or `/mcp/<secret>`) | Remote MCP server (Streamable HTTP) | Claude — claude.ai connectors, Claude Code, Claude Desktop |
| `/api/*` | Read-only JSON API | The frontend |
| `/`, `/recipes`, `/recipes/:id` | Astro server-rendered pages | You, in a browser |

**Design decision — writes only go through MCP.** The web API is deliberately read-only, so the public HTTP surface needs no auth story: the browser UI is for searching and cooking, while all mutations flow through the MCP endpoint, which is protected by an unguessable URL (see [Security](#security)).

## Features

**MCP server** (what Claude can do):
- `create_recipe` / `update_recipe` / `delete_recipe` — full CRUD with schema-validated inputs
- `search_recipes` — hybrid keyword and semantic search: prefixes like `tomat` and requests like `a cozy one-pot dinner`
- `list_recipes` / `get_recipe` / `list_tags` — browsing and pagination

**Frontend**:
- Search ingredients, dishes, or what you're craving; combine tags with AND filtering
- Five popular tags stay in one row; an expandable drawer shows the rest
- Results default to relevance during search, with quickest-first and alphabetical sorting available
- Cook-friendly detail view: ingredient checkboxes, numbered steps, prep/cook times
- Astro server-rendered pages with shareable search/tag URLs, light & dark theme, fully responsive
- Ingredient scaling, cooking progress, print layout, and smooth client navigation
- Public pages use a published recipe snapshot; MCP edits publish without a rebuild

**Infrastructure**:
- [Cloudflare Workers](https://developers.cloudflare.com/workers/) — compute + static assets
- [D1](https://developers.cloudflare.com/d1/) — serverless SQLite with an FTS5 index kept in sync by triggers
- [Durable Objects](https://developers.cloudflare.com/durable-objects/) — MCP session state (via Cloudflare's [`agents`](https://developers.cloudflare.com/agents/) SDK)

Everything fits comfortably in Cloudflare's free tier.

## Project structure

```
├── src/
│   ├── index.ts      # Worker entry: routes /mcp, /api/*, and Astro pages
│   ├── mcp.ts        # McpAgent subclass — the 7 MCP tools
│   ├── api.ts        # Read-only REST endpoints for the frontend
│   ├── db.ts         # D1 data access: CRUD, FTS query building, tag counts
│   ├── search.ts     # Workers AI embeddings + hybrid FTS5/Vectorize ranking
│   ├── search-index.ts # Durable indexing queue consumer (scheduled every 5 minutes)
│   └── types.ts      # Shared types (Env bindings, Recipe shapes)
│   ├── pages/        # Astro collection, recipe detail, and 404 routes
│   ├── layouts/      # Shared HTML shell and page metadata
│   ├── components/   # Server-rendered recipe cards
│   ├── client/       # Search navigation and cooking controls
│   └── lib/          # Shared presentation and ingredient scaling
├── public/           # CSS and illustrations copied to dist/client
├── astro.config.mjs  # Server rendering + Cloudflare adapter
├── schema.sql        # Tables, FTS5 index, sync triggers
├── migrations/       # Incremental ALTERs for databases created from older schemas
├── seed.sql          # Optional sample recipes
└── wrangler.jsonc    # Worker config: D1, Durable Object, assets bindings
```

## Setup

### Prerequisites

- Node.js 22.12+ (Astro requirement)
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

The live instance runs at [recipes.heuermann.xyz](https://recipes.heuermann.xyz). Its
`workers.dev` address and version URLs are disabled so they cannot bypass the custom
domain's WAF protection.

**Deploying your own instance:** use a domain whose DNS is on Cloudflare and change the
`routes` entry in `wrangler.jsonc` before deploying. Cloudflare creates the DNS record
and TLS certificate for you:

```jsonc
"routes": [{ "pattern": "recipes.example.com", "custom_domain": true }],
"workers_dev": false,
"preview_urls": false
```

Use your custom domain in the connector examples below.

## Connecting Claude

### claude.ai (web & mobile) — custom connector

1. **Settings → Connectors → Add custom connector**
2. Name it (e.g. "Recipe Box") and set the URL to:
   ```
   https://recipes.heuermann.xyz/mcp/<your-secret>
   ```
3. Add — no OAuth configuration needed.

Then just talk to Claude: *"Generate a weeknight pasta recipe and save it to my recipe box"*, *"What do I have tagged 'dessert'?"*, *"Update the chickpea curry — I doubled the garlic and it was better."*

### Claude Code

```sh
claude mcp add --transport http recipe-box https://recipes.heuermann.xyz/mcp/<your-secret>
```

### Claude Desktop (via mcp-remote)

```json
{
  "mcpServers": {
    "recipe-box": {
      "command": "npx",
      "args": ["mcp-remote", "https://recipes.heuermann.xyz/mcp/<your-secret>"]
    }
  }
}
```

## MCP tools reference

| Tool | Arguments | Description |
|---|---|---|
| `list_recipes` | `limit?`, `offset?`, `tag?`, `tags?[]` | Newest-first summaries; requires every supplied tag |
| `search_recipes` | `query`, `limit?`, `tags?[]` | Ranked keyword + semantic search; query up to 500 characters; requires every supplied tag |
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
| `/api/recipes` | `q` (search), repeated `tag` (AND), `limit`, `offset` | `{ recipes: RecipeSummary[], total }` |
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

## Semantic search

Recipes stay in D1. [Workers AI](https://developers.cloudflare.com/workers-ai/models/bge-base-en-v1.5/)
embeds compact recipe text using `@cf/baai/bge-base-en-v1.5` with `cls` pooling;
[Vectorize](https://developers.cloudflare.com/vectorize/reference/client-api/) stores the 768-dimensional
vectors in a cosine index. Search combines FTS5 and vector results with weighted reciprocal-rank
fusion, favoring keyword matches and recipes found by both methods. Vector-only matches must
meet a 0.55 similarity threshold; this is a tunable retrieval cutoff, not a probability.

Enable on an existing deployment:

```sh
npx wrangler vectorize create recipes-search --dimensions=768 --metric=cosine
npm run search:migrate
npm run deploy
```

The migration queues all existing recipes. A cron job processes up to 20 queued recipes every
five minutes. D1 triggers atomically queue creates, edits, and deletes, including changes made
directly in SQL. Jobs survive failures and are retried; leases prevent overlapping runs from
processing the same recipe. Vectorize applies accepted mutations asynchronously, so newly
saved recipes are immediately keyword-searchable and become semantically searchable after
indexing. Search hydrates vector results from D1 and rejects deleted recipes and embeddings
whose saved `updated_at` differs from the current recipe.

To rebuild embeddings or check progress:

```sh
npm run search:reindex
npx wrangler d1 execute recipes-db --remote --command="SELECT COUNT(*) AS pending FROM recipe_search_jobs"
npx wrangler vectorize info recipes-search
```

Query embeddings are cached for one day. Public searches use the published recipe
snapshot for keyword matching and vector hydration; MCP searches use D1 directly.
Public keyword search uses accent-insensitive prefix/AND matching with title boosts;
MCP keyword search retains SQLite FTS5 ranking. Both preserve exact AND tag filters.
Search skips AI for queries shorter than three characters and falls back to keywords if AI or
Vectorize fails or takes longer than four seconds. API and MCP responses include
`search: { mode: "hybrid" | "keyword", degraded: boolean }`; the site indicates temporary
keyword-only fallback. Text search still covers the complete recipe even when long prose is
omitted from its compact embedding. Semantic matches are suggestions, not strict dietary,
allergen, or time filters.

`npm run dev` selects the `local` Wrangler environment, which omits AI and Vectorize bindings
and uses keyword search. Direct local use of the production bindings is disabled with
`remote: false`, so development does not modify the production vector index. To exercise real
embeddings locally, use a separate development index and explicit remote bindings. Apply `npm run search:migrate:local`
to an existing local database. `npm test` runs SQL/FTS5, search, and indexing tests with real
in-memory SQLite and fake AI/Vectorize bindings (Node.js 22.13+); no account or network is required.

Workers AI and Vectorize have separate usage allowances and billing. See their current
[AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) and
[Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/) before scaling usage.

## Published recipe snapshot

Recipe detail pages include server-rendered schema.org `Recipe` JSON-LD generated from
the same snapshot as the visible page, with no additional database reads. It uses the
displayed image, ingredients, linked instruction steps, yield, and known prep/cook times.
Per-serving nutrition is included only when the saved yield gives a clear serving count.
Missing values, authors, and ratings are not invented; image-less recipes retain valid
schema but lack Google's required image for recipe rich results. Inline JSON is escaped
to prevent recipe text from closing its script element. See
[Google's Recipe guidelines](https://developers.google.com/search/docs/appearance/structured-data/recipe).

Public collection, filter, recipe, tag, and search requests read a persisted JSON catalog
from the `RecipeSnapshot` SQLite Durable Object. **Public production requests never query
D1**, including when the snapshot is unavailable. They return 503 in that case instead of
falling back to the database. Browsing from a published snapshot works during D1 outages.

D1 triggers advance the single `recipe_publication` revision on every recipe insert,
update, or delete. Successful MCP saves request a refresh immediately. The existing
five-minute cron checks the revision to catch direct SQL edits or retry failed publishes.
An unchanged check reads only the revision row; it does not scan recipes or rewrite the
snapshot. On change, the publisher reads the catalog and revision in one D1 batch transaction
and replaces the persisted document. The publisher serializes concurrent refreshes and
preserves the previous snapshot on failure. The document has a 1 MiB safety limit.

One 60-second edge cache entry serves **all** URLs and filter combinations, reducing Durable
Object requests too. Public API responses use `private, no-cache` with ETags so browser
caching does not add another minute of staleness. HTML uses `no-store`. Normal saves become
visible within about one minute after publication; direct SQL edits or failed refreshes
can take until the next successful cron plus cache expiry. MCP reads remain immediate.
Semantic search still uses Workers AI and Vectorize; only its D1 reads are eliminated.

The `X-Recipe-Data-Source`, `X-Recipe-Revision`, and `X-Recipe-Published-At` API headers identify
the snapshot. Local development, without the snapshot binding, uses D1 and a separate
60-second response cache with `X-Recipe-Cache: HIT|MISS`.

Existing deployments need the additive migration and initial publication:

```sh
npm run snapshot:migrate
npm run deploy
npm run snapshot:publish
```

The publish command uses the existing MCP secret from the environment or `.dev.vars`
and the authenticated `refresh_website` tool. The cron also initializes an empty publisher.
No new API token, paid subscription, KV namespace, or R2 bucket is needed.

`public/_headers` configures static assets. Illustrations are fresh for one day; replacing
an image at the same URL can take that long to appear. Unversioned JavaScript and CSS use
`no-cache`; Astro's hashed build assets are immutable.

## Traffic and snapshot analytics

Use the existing Cloudflare **Workers → recipes → Observability** and Metrics views for
request counts, status codes, errors, CPU, and caller metadata. No browser analytics beacon,
third-party service, or per-visit D1 write is added. Structured logs provide:

- `recipe_snapshot_published`: revision, recipe count, bytes.
- `recipe_snapshot_failed` / `recipe_snapshot_refresh_pending`: failed publication and retry.
- `recipe_snapshot_read`: durable reads logged in full; edge hits sampled at 1% (the
  `sampleRate` field distinguishes them). These are estimates when platform sampling applies.
- `recipe_snapshot_read_failed`: unavailable public snapshot.

`npm test` verifies zero public D1 reads across browsing, arbitrary filters, details, and
both search paths, plus direct SQL changes, concurrent refreshes, persistence, failed
publication recovery, cache expiry, and the existing API/search behavior.

## Usage and cost controls

Keep this account on **Workers Free** for a $0 Workers/D1 bill. Free quotas are shared
across the account: 100,000 Worker requests/day, 5 million D1 rows read/day, and 100,000
D1 rows written/day. At the limit, requests/queries fail until midnight UTC (5 p.m. in
Phoenix). A warning is not an overage charge. The Paid plan starts at $5/month and bills
overages; budget alerts and per-request CPU limits are not a monthly spending cap.
See [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), and
[budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/).

Production public page/API traffic is limited to 30 requests per minute per IP, with
search additionally limited to 10 per minute. Excess requests return 429 with a 60-second
retry hint before database or AI work. These counters are approximate and per Cloudflare
location; rejected requests still invoke the Worker. They reduce abuse, not enforce a
global quota. Static assets and MCP are separate. Local development omits the bindings.
The snapshot Durable Object also has Free plan limits; it is not unlimited storage/compute.
Worker requests still count even though public D1 reads have been removed.

`robots.txt` asks crawlers to skip filter/search URLs, and tag links use `nofollow`.
Tag links and cache keys use a stable order to avoid duplicate filter permutations.
These are crawler hints, not access control: the recipe website is still public.

Since September 27, 2026, the Cloudflare WAF custom rule **Recipes - challenge multi-tag
crawlers** applies a Managed Challenge to non-verified-bot requests on
`recipes.heuermann.xyz` at `/`, `/recipes`, or `/recipes/` with two or more `tag` parameters.
This catches the observed crawler pattern before it invokes the Worker. The rule is
managed in the Cloudflare dashboard, separately from `wrangler.jsonc`; redeploying the
Worker does not provision this rule. MCP and API routes are outside its scope.

Live checks confirmed challenge enforcement and working browser filtering. The alternate
`recipes.t-heuermann26.workers.dev` hostname was disabled on September 27 after confirming
no MCP connectors depended on it; version URLs were also disabled. Both settings are
persisted in `wrangler.jsonc`. The alternate hostname now returns 404; the custom-domain
site/API and the connected Recipe Box MCP tool were verified after the change.
A sustained reduction in crawler traffic has not yet been measured, and other request
patterns remain outside the rule. See the
[September crawler incident record](docs/operations/2026-09-crawler-incident.md) for the
exact rule, evidence, verification steps, and remaining work.

On September 26, 2026, D1 query insights for the preceding 24 hours showed approximately
78,000 tag queries (2.78M rows read), 77,000 collection queries (1.23M), and 76,000 count
queries (1.21M). The indexing cron used about 1,100 reads. Publishing on change removes this
repeated public database work. Dashboard request logs showed rapid requests for unrelated
three-tag combinations. Two inspected requests came from different IPv6 addresses on
RapidSeedbox (AS214483), claiming Windows Chrome/Edge and with no verified bot category.
This supports an external crawler as the cause, amplified by uncached filter pages.
To compare after deployment:

```sh
npx wrangler d1 insights recipes-db --time-period 1d --sort-by reads --limit 10 --json
```

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

## Astro development and deployment

`npm run dev` runs Astro with the isolated `local` Cloudflare environment and
the existing local D1 state. Apply the local schema and seed data if needed
(`npm run db:migrate:local`, `npm run db:seed:local`). No production AI or
Vectorize bindings are enabled locally.

- `npm run check` validates Astro pages and TypeScript.
- `npm test` runs API/search and frontend utility tests.
- With a seeded local server running, `npm run test:ssr` checks rendered HTML and routes.
- `npm run build` creates the production Worker and assets in `dist/`.
- `npm run build:local` then `npm run preview` tests the local production build.
- `npm run deploy` rebuilds for production and deploys the existing Worker.

Astro's Cloudflare adapter generates the deployment configuration. Keep
`src/index.ts` as the custom entry point: it preserves MCP authentication,
the Durable Object export, the read-only API, and the indexing schedule, then
passes page requests to Astro. No database migration is needed for the frontend.

Recipe URLs use stable IDs (`/recipes/rcp_…`) so renaming a recipe does not
break links. Legacy `#/recipe/:id` links redirect in the browser, since URL
fragments are never sent to the server. Search, repeated `tag` filters, and
`sort` live in query parameters; pages and forms work without JavaScript.
HTML is served with `Cache-Control: no-store`; production data comes from the published
snapshot with a 60-second edge cache. See the publication/retry behavior above.
