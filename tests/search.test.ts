import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createRecipe, updateRecipe, deleteRecipe, searchRecipes, listRecipes } from "../src/db";
import { hybridSearch, mergeSearchResults, recipeSearchText, EMBEDDING_DIMENSIONS } from "../src/search";
import { syncSearchIndex } from "../src/search-index";
import { handleApi } from "../src/api";
import { limitPublicTraffic } from "../src/traffic";
import { RecipeSnapshot, catalogList, catalogTags, catalogSearchSource, refreshRecipeSnapshot } from "../src/snapshot";

function edgeCache(t) {
  const entries = new Map();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const original = Object.getOwnPropertyDescriptor(globalThis, "caches");
  Object.defineProperty(globalThis, "caches", { configurable: true, value: { default: {
    async match(request) {
      const entry = entries.get(request.url);
      return entry && entry.expires > now ? entry.response.clone() : undefined;
    },
    async put(request, response) {
      assert.match(response.headers.get("cache-control"), /^public, max-age=60$/);
      entries.set(request.url, { response: response.clone(), expires: now + 60000 });
    },
  } } });
  t.after(() => original ? Object.defineProperty(globalThis, "caches", original) : delete globalThis.caches);
  return { entries, advance: ms => { now += ms; } };
}

test("shared API cache avoids D1 entirely on equivalent URLs and conditional hits, and expires after edits", async t => {
  const cache = edgeCache(t);
  const { env, add, db } = fixture(t);
  const recipe = await add({});
  const first = await handleApi(new Request("https://recipes.test/api/recipes?tag=dinner&tag=one-pot"), env);
  assert.equal(first.headers.get("x-recipe-cache"), "MISS");
  const prepare = t.mock.method(db, "prepare", () => { throw new Error("D1 must not be used on a cache hit"); });
  cache.advance(15000);
  const hit = await handleApi(new Request("https://recipes.test/api/recipes?tag=ONE-POT&tag=dinner&tag=dinner&sort=title&utm_source=crawler"), env);
  assert.equal(hit.headers.get("x-recipe-cache"), "HIT");
  assert.equal(hit.headers.get("cache-control"), "private, max-age=45, must-revalidate");
  assert.equal((await hit.json()).recipes[0].id, recipe.id);
  const conditional = await handleApi(new Request("https://recipes.test/api/recipes?tag=dinner&tag=one-pot", {
    headers: { "if-none-match": `W/${first.headers.get("etag")}` },
  }), env);
  assert.equal(conditional.status, 304);
  assert.equal(prepare.mock.callCount(), 0);
  prepare.mock.restore();
  await updateRecipe(db, recipe.id, { title: "Edited curry" });
  cache.advance(46000);
  const fresh = await handleApi(new Request("https://recipes.test/api/recipes?tag=dinner&tag=one-pot"), env);
  assert.equal(fresh.headers.get("x-recipe-cache"), "MISS");
  assert.equal((await fresh.json()).recipes[0].title, "Edited curry");
});

test("shared API cache keeps representations separate and never caches errors or degraded search", async t => {
  const cache = edgeCache(t);
  const { env, add, db } = fixture(t);
  const first = await add({ tags: ["first"] });
  const second = await add({ tags: ["second"] });
  for (const id of [first.id, second.id]) {
    const response = await handleApi(new Request(`https://recipes.test/api/recipes/${id}`), env);
    assert.equal((await response.json()).id, id);
  }
  const tagged = await handleApi(new Request("https://recipes.test/api/recipes?tag=second"), env);
  assert.deepEqual((await tagged.json()).recipes.map(r => r.id), [second.id]);
  const tagsUrl = new Request("https://recipes.test/api/tags");
  await handleApi(tagsUrl, env);
  const prepare = t.mock.method(db, "prepare", () => { throw new Error("offline"); });
  assert.equal((await handleApi(tagsUrl, env)).headers.get("x-recipe-cache"), "HIT");
  const beforeErrors = cache.entries.size;
  assert.equal((await handleApi(new Request("https://recipes.test/api/recipes/missing"), env)).status, 500);
  prepare.mock.restore();
  assert.equal((await handleApi(new Request("https://recipes.test/api/recipes/missing"), env)).status, 404);
  env.AI.run = async () => { throw new Error("offline"); };
  assert.equal((await handleApi(new Request("https://recipes.test/api/recipes?q=new-query"), env)).headers.get("cache-control"), "no-store");
  assert.equal(cache.entries.size, beforeErrors);
});

test("public traffic limits cover SSR and API but bypass MCP and static files", async () => {
  const calls = [];
  const env = { PUBLIC_RATE_LIMITER: { async limit({ key }) { calls.push(key); return { success: false }; } } };
  for (const path of ["/", "/recipes", "/recipes/", "/recipes/a", "/api/recipes", "/api/tags", "/api/recipes/a"]) {
    const result = await limitPublicTraffic(new Request(`https://recipes.test${path}`, { headers: { "cf-connecting-ip": "192.0.2.1" } }), env);
    assert.equal(result.status, 429);
    assert.equal(result.headers.get("retry-after"), "60");
  }
  for (const path of ["/mcp", "/mcp/secret", "/styles.css", "/robots.txt"]) {
    assert.equal(await limitPublicTraffic(new Request(`https://recipes.test${path}`), env), null);
  }
  assert.equal(calls.length, 7);
  assert.ok(calls.every(key => key === "recipes:read:192.0.2.1"));
  env.PUBLIC_RATE_LIMITER.limit = async () => ({ success: true });
  env.SEARCH_RATE_LIMITER = { async limit() { return { success: false }; } };
  assert.equal((await limitPublicTraffic(new Request("https://recipes.test/recipes?q=curry"), env)).status, 429);
  assert.equal(await limitPublicTraffic(new Request("https://recipes.test/recipes"), env), null);
  env.PUBLIC_RATE_LIMITER.limit = async () => { throw new Error("unavailable"); };
  assert.equal((await limitPublicTraffic(new Request("https://recipes.test/recipes"), env)).status, 503);
});

test("API browser caching validates unchanged content and detects recipe edits", async t => {
  const { env, add, db } = fixture(t);
  const recipe = await add({});
  const url = `https://recipes.test/api/recipes/${recipe.id}`;
  const initial = await handleApi(new Request(url), env);
  assert.equal(initial.headers.get("cache-control"), "private, max-age=60, must-revalidate");
  const etag = initial.headers.get("etag");
  assert.ok(etag);
  for (const validator of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
    const unchanged = await handleApi(new Request(url, { headers: { "if-none-match": validator } }), env);
    assert.equal(unchanged.status, 304);
    assert.equal(await unchanged.text(), "");
    assert.equal(unchanged.headers.get("etag"), etag);
    assert.equal(unchanged.headers.get("cache-control"), initial.headers.get("cache-control"));
  }
  await updateRecipe(db, recipe.id, { title: "Updated curry" });
  const changed = await handleApi(new Request(url, { headers: { "if-none-match": etag } }), env);
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get("etag"), etag);
  assert.equal((await changed.json()).title, "Updated curry");
});

test("collection and tags cache by representation; errors and degraded search do not", async t => {
  const { env, add } = fixture(t);
  await add({});
  for (const path of ["/api/recipes", "/api/tags", "/api/recipes?tag=dinner", "/api/recipes?q=curry"]) {
    const url = `https://recipes.test${path}`;
    const response = await handleApi(new Request(url), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, max-age=60, must-revalidate");
    assert.equal((await handleApi(new Request(url, { headers: { "if-none-match": response.headers.get("etag") } }), env)).status, 304);
  }
  for (const path of ["/api/recipes/missing", "/api/missing", `/api/recipes?q=${"a".repeat(501)}`]) {
    const response = await handleApi(new Request(`https://recipes.test${path}`), env);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("etag"), null);
  }
  env.AI.run = async () => { throw new Error("offline"); };
  const degraded = await handleApi(new Request("https://recipes.test/api/recipes?q=unique-new-query"), env);
  assert.equal(degraded.status, 200);
  assert.equal(degraded.headers.get("cache-control"), "no-store");
});

// Execute production SQL against real SQLite/FTS5 with a small D1 adapter.
// Only Workers AI and Vectorize are faked; no Cloudflare account is needed.
function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("schema.sql", "utf8"));
  t.after(() => sqlite.close());
  const db = {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async all() { return { results: sqlite.prepare(sql).all(...values) }; },
        async first() { return sqlite.prepare(sql).get(...values) ?? null; },
        async run() { const result = sqlite.prepare(sql).run(...values); return { meta: { changes: result.changes } }; },
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const result = await Promise.all(statements.map(statement => statement.all()));
        sqlite.exec("COMMIT");
        return result;
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
  const vectors = new Map();
  const calls = { ai: 0, query: 0, upsert: 0, delete: 0, texts: [] };
  const env = {
    DB: db,
    AI: {
      async run(model, input) {
        calls.ai++;
        calls.texts.push(...input.text);
        assert.equal(model, "@cf/baai/bge-base-en-v1.5");
        assert.equal(input.pooling, "cls");
        return { data: input.text.map(() => Array(EMBEDDING_DIMENSIONS).fill(0.01)) };
      },
    },
    RECIPE_VECTORS: {
      async query(_vector, options) {
        calls.query++;
        assert.ok(options.topK <= 50);
        assert.equal(options.returnMetadata, "all");
        return { matches: [...vectors.values()].map(vector => ({ ...vector, score: vector.score ?? 0.8 })) };
      },
      async upsert(entries) { calls.upsert++; for (const entry of entries) vectors.set(entry.id, entry); },
      async deleteByIds(ids) { calls.delete++; for (const id of ids) vectors.delete(id); },
    },
  };
  const add = input => createRecipe(db, {
    title: "Chickpea Curry", description: "A warming coconut curry.", tags: ["dinner", "one-pot"],
    ingredients: ["2 cans chickpeas", "1 can tomatoes", "3 cloves garlic"],
    instructions: ["Simmer everything."], ...input,
  });
  const jobs = () => sqlite.prepare("SELECT * FROM recipe_search_jobs").all();
  return { sqlite, db, env, add, vectors, calls, jobs };
}

function snapshotFixture(t, env) {
  const storage = new DatabaseSync(":memory:");
  t.after(() => storage.close());
  let queue = Promise.resolve();
  const state = {
    storage: { sql: { exec(sql, ...values) {
      const rows = storage.prepare(sql).all(...values);
      return { toArray: () => rows };
    } } },
    blockConcurrencyWhile(callback) {
      const run = queue.then(callback);
      queue = run.catch(() => {});
      return run;
    },
  };
  let publisher = new RecipeSnapshot(state, env);
  let reads = 0;
  env.RECIPE_SNAPSHOT = { getByName(name) {
    assert.equal(name, "catalog");
    return { fetch(input, init) {
      if (new URL(input).pathname === "/catalog") reads++;
      return publisher.fetch(new Request(input, init));
    } };
  } };
  return {
    state,
    get reads() { return reads; },
    restart() { publisher = new RecipeSnapshot(state, env); },
    async catalog() { return (await publisher.fetch(new Request("https://snapshot/catalog"))).json(); },
  };
}

test("snapshot publisher reads the catalog only after a revision change and catches direct SQL writes/deletes", async t => {
  const { env, add, db, sqlite } = fixture(t);
  const recipe = await add({});
  const published = snapshotFixture(t, env);
  const prepare = t.mock.method(db, "prepare");
  assert.equal(await refreshRecipeSnapshot(env), true);
  const countFullReads = () => prepare.mock.calls.filter(call => call.arguments[0].startsWith("SELECT * FROM recipes ORDER")).length;
  assert.equal(countFullReads(), 1);
  await Promise.all([refreshRecipeSnapshot(env), refreshRecipeSnapshot(env)]);
  assert.equal(countFullReads(), 1, "unchanged or overlapping refreshes only check the revision");
  sqlite.prepare("UPDATE recipes SET title = ? WHERE id = ?").run("Direct SQL edit", recipe.id);
  await refreshRecipeSnapshot(env);
  assert.equal(countFullReads(), 2);
  assert.equal((await published.catalog()).recipes[0].title, "Direct SQL edit");
  await deleteRecipe(db, recipe.id);
  await refreshRecipeSnapshot(env);
  assert.equal(countFullReads(), 3);
  assert.deepEqual((await published.catalog()).recipes, []);
  published.restart();
  assert.deepEqual((await published.catalog()).recipes, [], "published state survives object restarts");
});

test("public browsing, arbitrary tag combinations, recipe details and both search paths use zero D1 reads", async t => {
  edgeCache(t);
  const { env, add, db, vectors } = fixture(t);
  const recipe = await add({});
  const published = snapshotFixture(t, env);
  await refreshRecipeSnapshot(env);
  vectors.set(recipe.id, { id: recipe.id, metadata: { updated_at: recipe.updated_at } });
  const prepare = t.mock.method(db, "prepare", () => { throw new Error("D1 quota exceeded"); });
  for (const path of ["/api/recipes", "/api/tags", `/api/recipes/${recipe.id}`, "/api/recipes?q=chickpea", "/api/recipes?q=cozy+supper"]) {
    const response = await handleApi(new Request(`https://recipes.test${path}`), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-recipe-data-source"), "snapshot");
    assert.equal(response.headers.get("cache-control"), "private, no-cache");
  }
  for (let i = 0; i < 50; i++) {
    const result = await handleApi(new Request(`https://recipes.test/api/recipes?tag=unknown-${i}`), env);
    assert.equal((await result.json()).total, 0);
  }
  assert.equal((await handleApi(new Request("https://recipes.test/api/recipes/missing"), env)).status, 404);
  assert.equal(prepare.mock.callCount(), 0);
  assert.equal(published.reads, 1, "all URLs share one catalog cache entry");
  published.restart();
  assert.equal((await published.catalog()).recipes[0].id, recipe.id, "D1 outage does not prevent cold reads");
});

test("publication failures preserve the old snapshot, retry successfully and become visible after cache expiry", async t => {
  const cache = edgeCache(t);
  const { env, add, db } = fixture(t);
  const recipe = await add({});
  const published = snapshotFixture(t, env);
  await refreshRecipeSnapshot(env);
  const url = `https://recipes.test/api/recipes/${recipe.id}`;
  const initial = await handleApi(new Request(url), env);
  const etag = initial.headers.get("etag");
  await updateRecipe(db, recipe.id, { title: "New title" });
  const exec = published.state.storage.sql.exec;
  const failure = t.mock.method(published.state.storage.sql, "exec", (sql, ...values) => {
    if (sql.startsWith("INSERT")) throw new Error("storage temporarily unavailable");
    return exec(sql, ...values);
  });
  assert.equal(await refreshRecipeSnapshot(env), false);
  assert.equal((await published.catalog()).recipes[0].title, recipe.title);
  failure.mock.restore();
  assert.equal(await refreshRecipeSnapshot(env), true);
  assert.equal((await handleApi(new Request(url, { headers: { "if-none-match": etag } }), env)).status, 304);
  cache.advance(61000);
  const updated = await handleApi(new Request(url, { headers: { "if-none-match": etag } }), env);
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).title, "New title");
  assert.notEqual(updated.headers.get("etag"), etag);
});

test("snapshot tag counts, pagination and prefix AND search match the public contract", async t => {
  const { env, add } = fixture(t);
  const first = await add({ title: "Café Tomato Soup", tags: ["dinner", "quick"] });
  await add({ title: "Other dinner", tags: ["dinner"] });
  const published = snapshotFixture(t, env);
  await refreshRecipeSnapshot(env);
  const catalog = await published.catalog();
  assert.deepEqual(catalogTags(catalog), [{ tag: "dinner", count: 2 }, { tag: "quick", count: 1 }]);
  assert.deepEqual(catalogList(catalog, ["DINNER", "quick"]).recipes.map(r => r.id), [first.id]);
  assert.equal(catalogList(catalog, ["dinner"], 1, 1).recipes.length, 1);
  assert.equal(catalogList(catalog, ["dinner"], 1, 1).total, 2);
  const source = catalogSearchSource(catalog);
  assert.deepEqual((await source.keyword("cafe tomat", 25, ["dinner"])).map(r => r.id), [first.id]);
  assert.deepEqual(await source.keyword("cafe chocolate", 25, []), []);
});

test("an unpublished or unreachable snapshot fails closed without falling back to D1", async t => {
  const { env, db } = fixture(t);
  snapshotFixture(t, env);
  const prepare = t.mock.method(db, "prepare", () => { throw new Error("must not read D1"); });
  assert.equal((await handleApi(new Request("https://recipes.test/api/recipes"), env)).status, 503);
  assert.equal(prepare.mock.callCount(), 0);
});

test("keyword prefixes and AND matching continue to work against FTS5", async t => {
  const { db, add } = fixture(t);
  const recipe = await add({});
  assert.deepEqual((await searchRecipes(db, "TOMAT garlic")).map(r => r.id), [recipe.id]);
  assert.equal((await searchRecipes(db, "tomato chocolate")).length, 0);
});

test("tag selection uses exact AND matching before pagination and counting", async t => {
  const { db, add } = fixture(t);
  const both = await add({ tags: ["dinner", "quick"] });
  await add({ tags: ["dinner"] });
  await add({ tags: ["quick"] });
  const literal = await add({ tags: ["50%", "a_b", 'say "hi"'] });
  const result = await listRecipes(db, { tags: [" DINNER ", "quick", "quick"], limit: 1 });
  assert.deepEqual(result.recipes.map(r => r.id), [both.id]);
  assert.equal(result.total, 1);
  assert.equal((await listRecipes(db, { tags: ["dinner", "quick"], offset: 1 })).recipes.length, 0);
  assert.equal((await listRecipes(db, { tags: ["50%", "a_b", 'say "hi"'] })).recipes[0].id, literal.id);
  assert.equal((await listRecipes(db, { tags: ["a%"] })).total, 0);
  assert.equal((await listRecipes(db, { tag: "dinner", tags: ["quick"] })).total, 1);
});

test("both search paths and fallback require all selected tags", async t => {
  const { env, add, vectors } = fixture(t);
  const both = await add({ tags: ["dinner", "quick"] });
  const partial = await add({ tags: ["dinner"] });
  for (const recipe of [partial, both]) vectors.set(recipe.id, { id: recipe.id, metadata: { updated_at: recipe.updated_at } });
  for (const query of ["cozy supper", "chickpea"]) {
    const result = await hybridSearch(env, query, 1, ["dinner", "quick"]);
    assert.deepEqual(result.recipes.map(r => r.id), [both.id]);
  }
  const fallback = await hybridSearch({ DB: env.DB }, "chickpea", 1, ["quick", "dinner"]);
  assert.deepEqual(fallback.recipes.map(r => r.id), [both.id]);
  assert.equal((await hybridSearch(env, "cozy supper", 25, ["missing"])).recipes.length, 0);
});

test("API accepts repeated tag parameters alongside a query", async t => {
  const { env, add } = fixture(t);
  const both = await add({ tags: ["dinner", "quick"] });
  await add({ tags: ["dinner"] });
  for (const query of ["", "&q=chickpea"]) {
    const response = await handleApi(new Request(`https://recipes.test/api/recipes?tag=dinner&tag=quick${query}`), env);
    const result = await response.json();
    assert.deepEqual(result.recipes.map(r => r.id), [both.id]);
    assert.equal(result.total, 1);
  }
});

test("fusion deduplicates, promotes agreement, and preserves precise matches", () => {
  const a = { id: "a" }, b = { id: "b" }, c = { id: "c" };
  assert.deepEqual(mergeSearchResults([a, b], [b, c], 3).map(r => r.id), ["b", "a", "c"]);
  assert.equal(mergeSearchResults([a, b], [b, c], 1).length, 1);
});

test("meaning-based queries retrieve recipes with no literal matches", async t => {
  const { env, add, vectors, calls } = fixture(t);
  const recipe = await add({});
  vectors.set(recipe.id, { id: recipe.id, metadata: { updated_at: recipe.updated_at } });
  const result = await hybridSearch(env, "something cozy for a rainy evening");
  assert.deepEqual(result.recipes.map(r => r.id), [recipe.id]);
  assert.deepEqual(result.search, { mode: "hybrid", degraded: false });
  assert.match(calls.texts[0], /^Represent this sentence for searching relevant passages: /);
});

test("semantic results exclude weak, outdated, and deleted recipes", async t => {
  const { env, add, vectors } = fixture(t);
  const current = await add({}), stale = await add({}), weak = await add({});
  vectors.set(current.id, { id: current.id, metadata: { updated_at: current.updated_at } });
  vectors.set(stale.id, { id: stale.id, metadata: { updated_at: "old" } });
  vectors.set(weak.id, { id: weak.id, score: 0.2, metadata: { updated_at: weak.updated_at } });
  vectors.set("deleted", { id: "deleted", metadata: { updated_at: "old" } });
  assert.deepEqual((await hybridSearch(env, "cozy supper")).recipes.map(r => r.id), [current.id]);
});

test("AI and Vectorize failures preserve keyword results", async t => {
  for (const service of ["AI", "RECIPE_VECTORS"]) {
    const { env, add } = fixture(t);
    const recipe = await add({});
    if (service === "AI") env.AI.run = async () => { throw new Error("Unavailable"); };
    else env.RECIPE_VECTORS.query = async () => { throw new Error("Unavailable"); };
    const result = await hybridSearch(env, "chickpea");
    assert.deepEqual(result.recipes.map(r => r.id), [recipe.id]);
    assert.deepEqual(result.search, { mode: "keyword", degraded: true });
  }
});

test("malformed embeddings fall back before querying Vectorize", async t => {
  const { env, add, calls } = fixture(t);
  await add({});
  env.AI.run = async () => ({ data: [[NaN]] });
  assert.equal((await hybridSearch(env, "chickpea")).search.degraded, true);
  assert.equal(calls.query, 0);
});

test("a stalled semantic service returns keyword results within the timeout", async t => {
  const { env, add } = fixture(t);
  await add({});
  env.AI.run = () => new Promise(() => {});
  const start = Date.now();
  const result = await hybridSearch(env, "chickpea");
  assert.equal(result.search.degraded, true);
  assert.equal(result.recipes.length, 1);
  assert.ok(Date.now() - start < 5000);
});

test("unconfigured, short, and punctuation-only queries never call AI", async t => {
  const { env, add, calls } = fixture(t);
  const recipe = await add({});
  assert.deepEqual((await hybridSearch({ DB: env.DB }, "chickpea")).recipes.map(r => r.id), [recipe.id]);
  assert.equal((await hybridSearch(env, "ch")).recipes.length, 1);
  assert.equal((await hybridSearch(env, "!?" )).recipes.length, 0);
  assert.equal(calls.ai, 0);
  await assert.rejects(hybridSearch(env, "a".repeat(501)), RangeError);
});

test("result limits are enforced and the public API stays read-only", async t => {
  const { env, add } = fixture(t);
  await add({}); await add({});
  assert.equal((await hybridSearch(env, "chickpea", 1)).recipes.length, 1);
  const response = await handleApi(new Request("https://recipes.test/api/recipes?q=chickpea&limit=1"), env);
  const result = await response.json();
  assert.equal(result.recipes.length, 1);
  assert.equal(result.search.mode, "hybrid");
  assert.equal((await handleApi(new Request("https://recipes.test/api/recipes", { method: "POST" }), env)).status, 405);
  assert.equal((await handleApi(new Request(`https://recipes.test/api/recipes?q=${"a".repeat(501)}`), env)).status, 400);
});

test("create, update, and delete synchronize via the durable outbox", async t => {
  const { env, db, add, vectors, jobs, calls } = fixture(t);
  const recipe = await add({});
  assert.equal(jobs().length, 1);
  await syncSearchIndex(env);
  assert.equal(jobs().length, 0);
  assert.equal(vectors.get(recipe.id).values.length, EMBEDDING_DIMENSIONS);
  await updateRecipe(db, recipe.id, { title: "Spicy Curry" });
  await syncSearchIndex(env);
  assert.ok(calls.texts.some(text => text.startsWith("Spicy Curry")));
  await deleteRecipe(db, recipe.id);
  assert.equal((await hybridSearch(env, "cozy supper")).recipes.length, 0);
  await syncSearchIndex(env);
  assert.equal(vectors.size, 0);
  assert.equal(jobs().length, 0);
});

test("failed indexing remains queued, backs off, and succeeds on retry", async t => {
  const { env, add, sqlite, jobs, vectors } = fixture(t);
  const recipe = await add({});
  const run = env.AI.run;
  env.AI.run = async () => { throw new Error("Outage"); };
  await assert.rejects(syncSearchIndex(env), /Outage/);
  assert.equal(jobs()[0].lease_token, null);
  assert.ok(jobs()[0].next_attempt > Date.now() / 1000);
  env.AI.run = run;
  await syncSearchIndex(env);
  assert.equal(vectors.size, 0);
  sqlite.exec("UPDATE recipe_search_jobs SET next_attempt = 0");
  await syncSearchIndex(env);
  assert.ok(vectors.has(recipe.id));
  assert.equal(jobs().length, 0);
});

test("edits during embedding stay queued and overlapping runs cannot claim them", async t => {
  const { env, db, add, jobs, calls } = fixture(t);
  const recipe = await add({});
  const run = env.AI.run;
  let edited = false;
  env.AI.run = async (...args) => {
    if (!edited) {
      edited = true;
      await updateRecipe(db, recipe.id, { title: "Updated while indexing" });
      await syncSearchIndex(env);
      assert.equal(calls.upsert, 0);
    }
    return run(...args);
  };
  await syncSearchIndex(env);
  assert.equal(jobs().length, 1);
  assert.equal(jobs()[0].lease_token, null);
  await syncSearchIndex(env);
  assert.equal(jobs().length, 0);
  assert.ok(calls.texts.some(text => text.startsWith("Updated while indexing")));
});

test("expired leases recover after a crashed indexer", async t => {
  const { env, add, sqlite, jobs } = fixture(t);
  await add({});
  sqlite.exec("UPDATE recipe_search_jobs SET lease_token = 'crashed', lease_until = unixepoch() - 1");
  await syncSearchIndex(env);
  assert.equal(jobs().length, 0);
});

test("backfills are bounded and drain over multiple runs", async t => {
  const { env, add, jobs, vectors } = fixture(t);
  for (let i = 0; i < 21; i++) await add({ title: `Recipe ${i}` });
  await syncSearchIndex(env);
  assert.equal(vectors.size, 20);
  assert.equal(jobs().length, 1);
  await syncSearchIndex(env);
  assert.equal(vectors.size, 21);
  assert.equal(jobs().length, 0);
});

test("migration and backfill are repeatable and pick up existing recipes", async t => {
  const { env, add, sqlite, jobs } = fixture(t);
  await add({});
  await syncSearchIndex(env);
  const migration = readFileSync("migrations/0003_semantic_search.sql", "utf8");
  sqlite.exec(migration); sqlite.exec(migration);
  assert.equal(jobs().length, 1);
  await syncSearchIndex(env);
  sqlite.exec(readFileSync("scripts/reindex.sql", "utf8"));
  assert.equal(jobs().length, 1);
});

test("embedding text bounds lengthy prose while prioritizing searchable recipe fields", async t => {
  const { add } = fixture(t);
  const recipe = await add({ notes: "n".repeat(10000), instructions: ["i".repeat(10000)] });
  const text = recipeSearchText(recipe);
  assert.ok(text.length < 1800);
  assert.ok(text.includes("chickpeas"));
  assert.ok(text.startsWith(recipe.title));
});
