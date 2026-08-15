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

// ---------- ingredient scaling ----------
// Ingredients are free-text lines ("2 cups flour"), so scaling parses a leading
// quantity — including fractions and ranges — and rewrites it. Lines with no
// leading quantity pass through untouched. Scaling is view-local: nothing persists.

const VULGAR_FRACTIONS = {
  "½": 1 / 2, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 1 / 4, "¾": 3 / 4,
  "⅕": 1 / 5, "⅖": 2 / 5, "⅗": 3 / 5, "⅘": 4 / 5,
  "⅙": 1 / 6, "⅚": 5 / 6, "⅛": 1 / 8, "⅜": 3 / 8, "⅝": 5 / 8, "⅞": 7 / 8,
};

const FRACTION_GLYPHS = Object.entries(VULGAR_FRACTIONS).map(([glyph, value]) => ({ glyph, value }));

const VULGAR_CLASS = `[${Object.keys(VULGAR_FRACTIONS).join("")}]`;

// One quantity: "1 1/2", "1½", "1 ½", "1/2", "½", "1.5", "2". Mixed forms come
// first so "1 1/2" doesn't stop at "1".
const QUANTITY_RE = new RegExp(
  "^(?:" +
    "(\\d+)[ ]+(\\d+)\\s*\\/\\s*(\\d+)" +      // 1 1/2
    `|(\\d+)[ ]?(${VULGAR_CLASS})` +           // 1½ or 1 ½
    "|(\\d+)\\s*\\/\\s*(\\d+)" +               // 1/2
    `|(${VULGAR_CLASS})` +                     // ½
    "|(\\d+(?:\\.\\d+)?)" +                    // 1.5 or 2
  ")"
);

/** Parse a quantity at the start of `text`; returns { value, length } or null. */
function matchQuantity(text) {
  const m = QUANTITY_RE.exec(text);
  if (!m) return null;
  let value;
  if (m[1] !== undefined) value = Number(m[1]) + Number(m[2]) / Number(m[3]);
  else if (m[4] !== undefined) value = Number(m[4]) + VULGAR_FRACTIONS[m[5]];
  else if (m[6] !== undefined) value = Number(m[6]) / Number(m[7]);
  else if (m[8] !== undefined) value = VULGAR_FRACTIONS[m[8]];
  else value = Number(m[9]);
  if (!Number.isFinite(value)) return null;
  return { value, length: m[0].length };
}

/**
 * Parse the leading quantity (or range like "2-3" / "1 to 2") of an ingredient
 * line. Returns { values, sep, rest } or null. Numbers later in the line
 * (e.g. "1 can (400g) tomatoes") are deliberately left alone.
 */
function parseLeadingQuantity(line) {
  const lead = line.match(/^\s*/)[0];
  const first = matchQuantity(line.slice(lead.length));
  if (!first) return null;
  let end = lead.length + first.length;
  let values = [first.value];
  let sep = null;
  const sepMatch = line.slice(end).match(/^\s*(-|–|—|to)\s*/i);
  if (sepMatch) {
    const second = matchQuantity(line.slice(end + sepMatch[0].length));
    if (second) {
      values = [first.value, second.value];
      sep = sepMatch[1].toLowerCase() === "to" ? " to " : sepMatch[1];
      end += sepMatch[0].length + second.length;
    }
  }
  return { values, sep, rest: line.slice(end) };
}

/** Format a number cook-style: 1.5 → "1½", 0.25 → "¼"; decimals only as a last resort. */
function formatQuantity(value) {
  const whole = Math.floor(value + 1e-9);
  const frac = value - whole;
  if (frac < 0.02) return String(whole);
  if (frac > 0.98) return String(whole + 1);
  let best = null;
  for (const { glyph, value: fv } of FRACTION_GLYPHS) {
    const err = Math.abs(frac - fv);
    if (err <= 0.02 && (!best || err < best.err)) best = { glyph, err };
  }
  if (best) return whole ? `${whole}${best.glyph}` : best.glyph;
  return String(Math.round(value * 100) / 100);
}

/** Rewrite one ingredient line at the given scale factor. */
function scaleLine(line, factor) {
  if (factor === 1) return line;
  const parsed = parseLeadingQuantity(line);
  if (!parsed) return line;
  const nums = parsed.values.map((v) => formatQuantity(v * factor)).join(parsed.sep ?? "");
  const rest = parsed.rest.replace(/^\s+/, "");
  return rest ? `${nums} ${rest}` : nums;
}

/** First number in a servings string ("4-6 servings" → 4), or null. */
function parseServings(text) {
  const m = /\d+(?:\.\d+)?/.exec(text ?? "");
  const n = m ? Number(m[0]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---------- list view ----------

async function fetchRecipes() {
  const params = new URLSearchParams();
  if (state.query) params.set("q", state.query);
  else if (state.tag) params.set("tag", state.tag);
  const qs = params.toString();
  return api(`/api/recipes${qs ? `?${qs}` : ""}`);
}

/** Only http(s) URLs are ever rendered as images/links. */
function safeUrl(url) {
  return /^https?:\/\//i.test(url ?? "") ? url : null;
}

function recipeCard(recipe) {
  const time = totalTime(recipe);
  const img = safeUrl(recipe.image_url);
  return el(
    "a",
    { class: "card", href: `#/recipe/${recipe.id}` },
    img ? el("img", { class: "card-img", src: img, alt: "", loading: "lazy" }) : null,
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

const NUTRITION_ROWS = [
  ["calories", "Calories", ""],
  ["protein_g", "Protein", " g"],
  ["fat_g", "Fat", " g"],
  ["saturated_fat_g", "Sat. fat", " g"],
  ["carbohydrates_g", "Carbs", " g"],
  ["fiber_g", "Fiber", " g"],
  ["sugar_g", "Sugar", " g"],
  ["sodium_mg", "Sodium", " mg"],
];

function nutritionPanel(nutrition) {
  if (!nutrition) return null;
  const cells = NUTRITION_ROWS.filter(([key]) => typeof nutrition[key] === "number").map(
    ([key, label, unit]) =>
      el(
        "div",
        { class: "nutrition-cell" },
        el("span", { class: "nutrition-value" }, `${nutrition[key]}${unit}`),
        el("span", { class: "nutrition-label" }, label)
      )
  );
  if (cells.length === 0) return null;
  return el(
    "aside",
    { class: "nutrition" },
    el(
      "h2",
      {},
      "Nutrition",
      nutrition.serving_size
        ? el("span", { class: "nutrition-serving" }, ` · per ${nutrition.serving_size}`)
        : el("span", { class: "nutrition-serving" }, " · per serving")
    ),
    el("div", { class: "nutrition-grid" }, cells)
  );
}

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

  // Ephemeral scaling: adjust servings (or a bare multiplier when servings
  // isn't a number) and rewrite ingredient quantities to match. Resets on
  // every navigation; nothing is saved.
  const ingredientSpans = recipe.ingredients.map((item) => el("span", {}, item));

  function applyFactor(factor) {
    ingredientSpans.forEach((span, i) => {
      span.textContent = scaleLine(recipe.ingredients[i], factor);
    });
  }

  const baseServings = parseServings(recipe.servings);
  let servingsControl;
  if (baseServings) {
    let servings = baseServings;
    const count = el("span", { class: "servings-count" }, servings);
    const setServings = (n) => {
      servings = Math.max(1, n);
      count.textContent = servings;
      count.classList.toggle("scaled", servings !== baseServings);
      count.title = servings === baseServings ? "" : `Originally serves ${recipe.servings}`;
      applyFactor(servings / baseServings);
    };
    servingsControl = el(
      "span",
      { class: "servings-stepper" },
      el("strong", {}, "Serves: "),
      el("button", { class: "step", "aria-label": "Fewer servings", onclick: () => setServings(servings - 1) }, "−"),
      count,
      el("button", { class: "step", "aria-label": "More servings", onclick: () => setServings(servings + 1) }, "+")
    );
  } else {
    const factors = [
      [0.5, "½×"],
      [1, "1×"],
      [2, "2×"],
      [3, "3×"],
    ];
    const buttons = factors.map(([factor, label]) =>
      el(
        "button",
        {
          class: `scale-btn${factor === 1 ? " active" : ""}`,
          onclick: () => {
            buttons.forEach((b) => b.classList.remove("active"));
            buttons[factors.findIndex(([f]) => f === factor)].classList.add("active");
            applyFactor(factor);
          },
        },
        label
      )
    );
    servingsControl = el(
      "span",
      { class: "scale-row" },
      recipe.servings ? el("strong", {}, `Serves ${recipe.servings} · `) : el("strong", {}, "Scale: "),
      buttons
    );
  }

  const meta = el(
    "div",
    { class: "meta-row" },
    servingsControl,
    prep ? el("span", {}, el("strong", {}, "Prep: "), prep) : null,
    cook ? el("span", {}, el("strong", {}, "Cook: "), cook) : null,
    recipe.tags.map((t) => el("span", { class: "mini-tag" }, t))
  );

  const ingredients = el(
    "ul",
    { class: "ingredients" },
    ingredientSpans.map((span) =>
      el("li", {}, el("label", {}, el("input", { type: "checkbox" }), span))
    )
  );

  const steps = el(
    "ol",
    { class: "steps" },
    recipe.instructions.map((step) => el("li", {}, step))
  );

  const sourceIsUrl = /^https?:\/\//i.test(recipe.source);
  const heroImg = safeUrl(recipe.image_url);

  app.replaceChildren(
    el("a", { class: "back-link", href: "#/" }, "← All recipes"),
    el(
      "article",
      { class: "recipe" },
      heroImg ? el("img", { class: "recipe-hero", src: heroImg, alt: recipe.title }) : null,
      el("h1", {}, recipe.title),
      recipe.description ? el("p", { class: "description" }, recipe.description) : null,
      meta,
      el(
        "div",
        { class: "recipe-columns" },
        el("section", {}, el("h2", {}, "Ingredients"), ingredients),
        el("section", {}, el("h2", {}, "Steps"), steps)
      ),
      nutritionPanel(recipe.nutrition),
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
