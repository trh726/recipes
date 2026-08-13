/**
 * Recipe Box frontend — a small hash-routed SPA, no framework.
 *
 * Routes:
 *   #/               list + search + tag filter
 *   #/recipe/:id     recipe detail
 *
 * Data comes from the Worker's read-only API (/api/recipes, /api/tags).
 */
"use strict";

const app = document.getElementById("app");

/** In-memory UI state for the list view (survives back-navigation). */
const state = {
  query: "",
  tag: null,
  tags: [],
};

// ---------- utilities ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2), value);
    } else if (value !== null && value !== undefined) {
      node.setAttribute(key, value);
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`API ${res.status} for ${path}`);
  return res.json();
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function formatMinutes(mins) {
  if (mins === null || mins === undefined) return null;
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

function totalTime(recipe) {
  const prep = recipe.prep_time_minutes ?? 0;
  const cook = recipe.cook_time_minutes ?? 0;
  const total = prep + cook;
  return total > 0 ? formatMinutes(total) : null;
}

// ---------- list view ----------

async function fetchRecipes() {
  const params = new URLSearchParams();
  if (state.query) params.set("q", state.query);
  else if (state.tag) params.set("tag", state.tag);
  const qs = params.toString();
  return api(`/api/recipes${qs ? `?${qs}` : ""}`);
}

function recipeCard(recipe) {
  const time = totalTime(recipe);
  return el(
    "a",
    { class: "card", href: `#/recipe/${recipe.id}` },
    el("h2", {}, recipe.title),
    recipe.description ? el("p", {}, recipe.description) : null,
    el(
      "div",
      { class: "card-meta" },
      time ? el("span", {}, `⏱ ${time}`) : null,
      recipe.servings ? el("span", {}, recipe.servings) : null,
      recipe.tags.slice(0, 4).map((t) => el("span", { class: "mini-tag" }, t))
    )
  );
}

async function renderList() {
  app.replaceChildren(el("p", { class: "loading" }, "Loading recipes…"));

  const searchInput = el("input", {
    type: "search",
    placeholder: "Search recipes, ingredients, notes…",
    value: state.query,
    "aria-label": "Search recipes",
  });

  const count = el("span", { class: "result-count" });
  const tagBar = el("div", { class: "tag-bar" });
  const grid = el("div", { class: "grid" });

  async function refresh() {
    try {
      const data = await fetchRecipes();
      const recipes = data.recipes ?? [];
      count.textContent =
        state.query
          ? `${recipes.length} match${recipes.length === 1 ? "" : "es"}`
          : `${data.total ?? recipes.length} recipe${(data.total ?? recipes.length) === 1 ? "" : "s"}`;

      if (recipes.length === 0) {
        grid.replaceChildren(
          el(
            "div",
            { class: "empty" },
            el("p", {}, state.query || state.tag ? "Nothing matched." : "Your recipe box is empty."),
            el(
              "p",
              { class: "hint" },
              state.query || state.tag
                ? "Try a different search term or clear the tag filter."
                : "Ask Claude to save a recipe — anything it generates or you paste in chat can land here via the MCP connector."
            )
          )
        );
      } else {
        grid.replaceChildren(...recipes.map(recipeCard));
      }
    } catch (err) {
      console.error(err);
      grid.replaceChildren(el("p", { class: "empty" }, "Couldn't load recipes. Try refreshing."));
    }
  }

  function renderTagBar() {
    const chips = state.tags.map(({ tag, count: n }) =>
      el(
        "button",
        {
          class: `tag-chip${state.tag === tag ? " active" : ""}`,
          onclick: () => {
            state.tag = state.tag === tag ? null : tag;
            state.query = "";
            searchInput.value = "";
            renderTagBar();
            refresh();
          },
        },
        `${tag} (${n})`
      )
    );
    tagBar.replaceChildren(...chips);
  }

  searchInput.addEventListener(
    "input",
    debounce(() => {
      state.query = searchInput.value.trim();
      if (state.query) state.tag = null;
      renderTagBar();
      refresh();
    }, 250)
  );

  app.replaceChildren(
    el("div", { class: "toolbar" }, el("div", { class: "search" }, searchInput), count),
    tagBar,
    grid
  );

  // Tags load once per session; failures just leave the bar empty.
  if (state.tags.length === 0) {
    api("/api/tags")
      .then((data) => {
        state.tags = data.tags ?? [];
        renderTagBar();
      })
      .catch(() => {});
  } else {
    renderTagBar();
  }

  await refresh();
}

// ---------- detail view ----------

async function renderRecipe(id) {
  app.replaceChildren(el("p", { class: "loading" }, "Loading recipe…"));

  let recipe;
  try {
    recipe = await api(`/api/recipes/${encodeURIComponent(id)}`);
  } catch {
    app.replaceChildren(
      el("a", { class: "back-link", href: "#/" }, "← All recipes"),
      el("p", { class: "empty" }, "Recipe not found.")
    );
    return;
  }

  const prep = formatMinutes(recipe.prep_time_minutes);
  const cook = formatMinutes(recipe.cook_time_minutes);

  const meta = el(
    "div",
    { class: "meta-row" },
    recipe.servings ? el("span", {}, el("strong", {}, "Serves: "), recipe.servings) : null,
    prep ? el("span", {}, el("strong", {}, "Prep: "), prep) : null,
    cook ? el("span", {}, el("strong", {}, "Cook: "), cook) : null,
    recipe.tags.map((t) => el("span", { class: "mini-tag" }, t))
  );

  const ingredients = el(
    "ul",
    { class: "ingredients" },
    recipe.ingredients.map((item) =>
      el("li", {}, el("label", {}, el("input", { type: "checkbox" }), el("span", {}, item)))
    )
  );

  const steps = el(
    "ol",
    { class: "steps" },
    recipe.instructions.map((step) => el("li", {}, step))
  );

  const sourceIsUrl = /^https?:\/\//i.test(recipe.source);

  app.replaceChildren(
    el("a", { class: "back-link", href: "#/" }, "← All recipes"),
    el(
      "article",
      { class: "recipe" },
      el("h1", {}, recipe.title),
      recipe.description ? el("p", { class: "description" }, recipe.description) : null,
      meta,
      el(
        "div",
        { class: "recipe-columns" },
        el("section", {}, el("h2", {}, "Ingredients"), ingredients),
        el("section", {}, el("h2", {}, "Steps"), steps)
      ),
      recipe.notes
        ? el("aside", { class: "notes" }, el("h2", {}, "Notes"), el("p", {}, recipe.notes))
        : null,
      recipe.source
        ? el(
            "p",
            { class: "source-line" },
            "Source: ",
            sourceIsUrl
              ? el("a", { href: recipe.source, target: "_blank", rel: "noopener" }, recipe.source)
              : recipe.source
          )
        : null
    )
  );
}

// ---------- router ----------

function route() {
  const hash = location.hash || "#/";
  const recipeMatch = hash.match(/^#\/recipe\/([A-Za-z0-9_-]+)$/);
  if (recipeMatch) {
    renderRecipe(recipeMatch[1]);
  } else {
    renderList();
  }
  window.scrollTo(0, 0);
}

window.addEventListener("hashchange", route);
route();
