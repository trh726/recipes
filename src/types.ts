/** Bindings available to the Worker (declared in wrangler.jsonc). */
export interface Env {
  /** D1 database holding the recipes. */
  DB: D1Database;
  /** Static frontend assets (./public). */
  ASSETS: Fetcher;
  /** Durable Object namespace backing the MCP agent. */
  MCP_OBJECT: DurableObjectNamespace;
  /**
   * Optional shared secret. When set (via `wrangler secret put MCP_SECRET`),
   * the MCP endpoint moves from /mcp to /mcp/<secret>.
   */
  MCP_SECRET?: string;
}

/** A recipe as stored/returned by the app (ingredients etc. parsed from JSON). */
export interface Recipe {
  id: string;
  title: string;
  description: string;
  ingredients: string[];
  instructions: string[];
  tags: string[];
  servings: string;
  prep_time_minutes: number | null;
  cook_time_minutes: number | null;
  source: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

/** Compact shape used in list/search results. */
export interface RecipeSummary {
  id: string;
  title: string;
  description: string;
  tags: string[];
  servings: string;
  prep_time_minutes: number | null;
  cook_time_minutes: number | null;
  updated_at: string;
}

/** Fields accepted when creating a recipe. */
export interface RecipeInput {
  title: string;
  description?: string;
  ingredients: string[];
  instructions: string[];
  tags?: string[];
  servings?: string;
  prep_time_minutes?: number | null;
  cook_time_minutes?: number | null;
  source?: string;
  notes?: string;
}
