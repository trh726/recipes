# Recipe Worker crawler incident — September 26–27, 2026

Status: the observed multi-tag crawl is covered by an active Cloudflare Managed Challenge.
Enforcement and normal browser filtering were verified after the user activated the rule
on September 27. The alternate `workers.dev` hostname gap found at 17:48 UTC was closed
at **17:59 UTC / 10:59 a.m. Phoenix** that day, after the user confirmed no MCP connectors
used it. The custom-domain site/API, Managed Challenge, and authenticated Recipe Box MCP
lookup all worked after the change.
A sustained reduction in incoming crawler traffic or Worker invocations has not been
measured. This is a mitigation for the observed pattern, not a guarantee against all abuse.

## Cause and evidence

An external crawler rapidly requested `/recipes?tag=…&tag=…&tag=…`, progressing to
four-tag combinations. Most combinations were unrelated or had no results. Each page
request invoked server rendering; before the snapshot change, it also repeated D1
collection, count, and tag queries.

- September 26 D1 insights for the preceding 24 hours showed roughly 78,000 tag queries
  (2.78 million rows read), 77,000 collection queries (1.23 million), and 76,000 count
  queries (1.21 million). The indexing cron accounted for about 1,100 reads.
- Two requests inspected during the initial investigation used different IPv6 addresses
  on RapidSeedbox, AS214483, claimed Windows Chrome/Edge, and had no verified bot category.
  This is evidence about those samples, not attribution of every request to that network.
- On September 27, Workers Observability grouped by `$workers.event.request.path` over
  a rolling 24-hour window showed approximately **143,000 `/recipes` events versus one
  MCP-path event**. The surge was public recipe browsing, not an MCP request loop.
  Logs may be sampled and include internal events; these figures are not billing totals.
- At approximately **07:50–07:51 Phoenix / 14:50–14:51 UTC**, logs showed many requests
  per second for changing four-tag combinations and repeated CPU-limit errors. Both
  HTTP and HTTPS recipe URLs appeared.
- The most recent hour inspected before activation was already quiet, mostly scheduled
  maintenance. Do not attribute that quiet period to a rule activated later.

Never put the real MCP capability URL, credentials, or raw request headers in this record.

## Fixes in place

| Layer | Implementation | What it protects |
| --- | --- | --- |
| Published catalog | `src/snapshot.ts`, `src/api.ts`, `migrations/0004_recipe_snapshot.sql` | Public production reads use the persisted `RecipeSnapshot` Durable Object catalog instead of D1. An unavailable snapshot yields 503 rather than a D1 fallback. |
| Publication and caching | Recipe revisions, refresh after MCP writes, five-minute cron, one shared 60-second edge-cached catalog | Refreshes on change and avoids database scans per public page or filter combination. MCP reads still use D1; semantic search can still use AI/Vectorize. |
| Worker rate limits | `src/traffic.ts`, bindings in `wrangler.jsonc` | Public data routes: 30 requests/minute/IP; searches: an additional 10/minute/IP. Approximate and per Cloudflare location. Rejected requests still invoke the Worker. |
| Crawler hints | `public/robots.txt`, `nofollow` tag links, stable tag order | Discourages cooperative crawlers from enumerating filter URLs; does not enforce access. |
| Cloudflare WAF | Dashboard custom rule below | Challenges the observed multi-tag pattern before the Worker runs. Humans can pass the check. |
| Alternate URLs disabled | Live Worker subdomain settings; `workers_dev: false` and `preview_urls: false` in `wrangler.jsonc` | Closes the observed `recipes.t-heuermann26.workers.dev` bypass and disables the Worker's version URLs. |

The snapshot addressed D1 load. It did not stop Worker invocations or server-rendering CPU
usage, which is why the account could still receive Worker request-usage warnings.
The existing Free-plan posture is not a substitute for traffic control or an availability
guarantee; Workers AI and other services have their own usage terms.

## Active WAF rule

- Zone: `heuermann.xyz`.
- Name: **Recipes - challenge multi-tag crawlers**.
- Rule ID: `5ec2d4b68194481bb70cec8015413c36` (resource identifier, not a secret).
- Action: **Managed Challenge**; status **Active**; order **1** when verified.
- Activated by the user on September 27, 2026; confirmed active around 16:50 UTC.
- [Dashboard rule](https://dash.cloudflare.com/3d791f9ec7b4a4ca4bb13d5c4fe9c990/heuermann.xyz/security/security-rules/custom-rules/5ec2d4b68194481bb70cec8015413c36).

```text
(http.host eq "recipes.heuermann.xyz" and http.request.uri.path in {"/" "/recipes" "/recipes/"} and len(http.request.uri.args["tag"]) gt 1 and not cf.client.bot)
```

The expression counts `tag` parameters, not distinct tag values, and exempts Cloudflare
verified bots. It applies to both HTTP and HTTPS. It does not match `/mcp`, `/api/*`,
individual recipe detail paths, or other hostnames.

This is a dashboard-managed zone rule, **not part of the Wrangler deployment**. A fresh
deployment or migration to another zone must account for it separately. Do not assume
`npm run deploy` creates it. No embedded Turnstile widget was added to the application.
Cloudflare may show a verification page and, when needed, an interactive check.
See [Managed Challenge behavior](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/).

## Verification performed

| Check on September 27 | Result |
| --- | --- |
| Dashboard rule and expression | Active with the expression above |
| Direct HTTPS request to `/recipes?tag=beans&tag=braise` without browser clearance | 403 and `cf-mitigated: challenge` at 16:50 UTC; repeated at 17:45 UTC with the same result |
| Homepage `/` | 200 with recipe collection HTML at 16:50 UTC; repeated successfully at 17:45 UTC |
| `/recipes?tag=beans` | 200 with matching recipes |
| `/api/recipes` | 200 JSON; `X-Recipe-Data-Source: snapshot` |
| Bare `/mcp` | Expected 401 JSON authentication response, not a challenge page; this checks routing, not an authenticated MCP session |
| Chrome navigation: collection → dinner → dinner + quick | Filtered recipe page loaded successfully with both tags in the URL |
| Same two-tag URL on `recipes.t-heuermann26.workers.dev` at 17:48 UTC | 200 recipe HTML (`beans + braise`), without `cf-mitigated: challenge`; confirms the alternate-host gap |
| Alternate hostname after disabling at 17:59 UTC | Same two-tag URL returned 404; Cloudflare API readback confirmed `enabled: false` and `previews_enabled: false` |
| Custom domain after disabling the alternate hostname at 17:59 UTC | Homepage and `/api/recipes` returned 200; API used snapshot data; multi-tag URL returned 403 with `cf-mitigated: challenge`; bare `/mcp` returned expected 401 |
| Connected Recipe Box MCP `list_recipes` with `limit: 1` | Succeeded before and after disabling the alternate hostname, returning a saved recipe; verifies an authenticated connector call |
| Local production build after config change | `npm run build` passed; generated `dist/server/wrangler.json` preserved both disabled URL settings and the custom-domain route |

The installed Astro router falls back to full navigation when fetched HTML lacks its
transition marker, allowing a challenge page to load normally. Keep testing this flow
when changing client navigation. Cloudflare challenge pages return HTML and can disrupt
JSON/fetch clients; do not broaden the rule to MCP/API routes without addressing that.

The direct 403 proves enforcement for the tested request. A browser success proves that
normal browsing worked in that session. Neither measurement proves the crawler cannot
adapt or measures a sustained reduction. No ongoing monitoring job was created.

## Alternate hostname retired

At 17:48 UTC, the same two-tag request returned recipe HTML on the alternate hostname
without a challenge. The user confirmed no MCP connectors used it and requested its
removal. At 17:59:15 UTC, the
[Worker script subdomain API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subdomain/methods/create/)
accepted `enabled: false` and `previews_enabled: false`; both were previously true.
A subsequent GET confirmed both settings were false. This changed routing on the
existing Worker without deploying the unrelated application changes in the working tree.

The source config now explicitly sets `workers_dev: false` and `preview_urls: false`;
the rebuilt deployment config matches. Keep these values when deploying. Disabling only
the live address can be undone by a later deployment, and version URLs have a separate
setting. See Cloudflare's [workers.dev routing documentation](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
and [version URL documentation](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/).
README connector examples now use the custom domain. No real MCP capability URL was
recorded. Re-enabling either setting would require reassessing the WAF bypass.

## Remaining limits and follow-up

1. **Other patterns:** zero/one-tag browsing, searches, APIs, verified bots, and clients
   that pass the challenge can still consume Worker requests. Do not claim a global
   request cap or complete denial-of-service protection from this rule.
2. **Measure over time:** compare a fresh period after activation with a comparable
   earlier period. The earlier burst had already subsided before the rule was activated.
   Cumulative 24-hour totals do not immediately reset when a rule is enabled.

## If usage rises again

1. In **Workers & Pages → recipes → Metrics**, inspect request rate and CPU errors for
   the relevant period. In **Observability**, group by `$workers.event.request.path`
   and inspect request hostnames and query patterns. Redact MCP secrets from any notes.
2. In **heuermann.xyz → Security → Security rules**, confirm this rule is active.
   Open its events and review challenge outcomes. Use **Security Analytics** to see
   requests stopped before they reach the Worker; their absence from Worker logs alone
   does not tell you how much traffic was challenged.
3. Recheck a few known routes, rather than load-testing production:

   ```sh
   curl -sS -D - -o /dev/null https://recipes.heuermann.xyz/
   curl -sS -D - -o /dev/null 'https://recipes.heuermann.xyz/recipes?tag=beans&tag=braise'
   curl -sS -D - -o /dev/null https://recipes.heuermann.xyz/api/recipes
   ```

   Expect homepage/API success and `cf-mitigated: challenge` on an uncleared multi-tag
   request. Test actual tag-link navigation in a browser too. Do not record clearance
   cookies or authenticated MCP URLs.
4. Check D1 separately if database usage rises:

   ```sh
   npx wrangler d1 insights recipes-db --time-period 1d --sort-by reads --limit 10 --json
   ```

   Keep time windows and sampling in mind. The initial Wrangler OAuth token could read
   D1 insights but the observability telemetry API returned 403; the signed-in dashboard
   provided request-path evidence. An API-permission failure is not evidence of no traffic.
5. Adjust protection to the new evidence. Adding more checks inside the Worker cannot
   prevent those requests from invoking it. If legitimate browsing breaks, disable or
   narrow this specific WAF rule and retest; doing so reopens the matched crawler route.
   Avoid zone-wide changes that could affect other services or MCP integrations.
