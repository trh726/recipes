/**
 * Remote MCP server exposing recipe CRUD tools.
 *
 * Built on Cloudflare's `agents` SDK: `McpAgent` is a Durable Object that
 * holds MCP session state, while the tools below read/write the shared D1
 * database. Claude (claude.ai custom connectors, Claude Code, etc.) connects
 * over Streamable HTTP at /mcp — see src/index.ts for routing.
 */
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./types";
import {
  createRecipe,
  deleteRecipe,
  getRecipe,
  listRecipes,
  listTags,
  searchRecipes,
  updateRecipe,
} from "./db";

/** Wrap a payload as an MCP text result. */
function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

// Field schemas shared by create_recipe and update_recipe.
const recipeFields = {
  title: z.string().min(1).describe("Recipe title, e.g. 'Weeknight Chicken Tinga Tacos'"),
  description: z
    .string()
    .describe("One or two sentences on what the dish is and why it's good"),
  ingredients: z
    .array(z.string())
    .describe(
      "Ingredient lines with quantities, e.g. '2 tbsp olive oil'. Always use Imperial/US units " +
        "(cups, tbsp, tsp, oz, lb) — convert metric amounts before saving."
    ),
  instructions: z
    .array(z.string())
    .describe(
      "Ordered preparation steps, one step per array item. Use Imperial/US units; oven and " +
        "cooking temperatures in °F."
    ),
  tags: z
    .array(z.string())
    .describe("Short lowercase tags for filtering, e.g. ['dinner', 'mexican', 'quick']"),
  servings: z.string().describe("Yield as free text, e.g. '4 servings' or '12 cookies'"),
  prep_time_minutes: z.number().int().min(0).nullable().describe("Active prep time in minutes"),
  cook_time_minutes: z.number().int().min(0).nullable().describe("Cook/bake time in minutes"),
  source: z.string().describe("Where the recipe came from: a URL or free text"),
  notes: z
    .string()
    .describe("Tips, substitutions, and things learned from making it"),
  image_url: z
    .string()
    .describe("HTTPS URL of a photo of the dish. Pass an empty string to clear it."),
  nutrition: z
    .object({
      serving_size: z.string().optional().describe("What one serving is, e.g. '1 bowl (350g)'"),
      calories: z.number().min(0).optional().describe("kcal per serving"),
      protein_g: z.number().min(0).optional().describe("Protein in grams"),
      fat_g: z.number().min(0).optional().describe("Total fat in grams"),
      saturated_fat_g: z.number().min(0).optional().describe("Saturated fat in grams"),
      carbohydrates_g: z.number().min(0).optional().describe("Total carbohydrates in grams"),
      fiber_g: z.number().min(0).optional().describe("Dietary fiber in grams"),
      sugar_g: z.number().min(0).optional().describe("Sugar in grams"),
      sodium_mg: z.number().min(0).optional().describe("Sodium in milligrams"),
    })
    .describe(
      "Per-serving nutrition estimate (all fields optional). When estimating rather than " +
        "copying from a source, say so in the recipe notes."
    ),
};

export class RecipesMcpAgent extends McpAgent<Env> {
  server = new McpServer({
    name: "recipe-box",
    version: "1.0.0",
  });

  async init() {
    const db = () => this.env.DB;

    this.server.registerTool(
      "list_recipes",
      {
        title: "List recipes",
        description:
          "List saved recipes, newest first. Returns compact summaries (id, title, tags, times). " +
          "Optionally filter by a single tag. Use get_recipe for full details.",
        inputSchema: {
          limit: z.number().int().min(1).max(100).optional().describe("Max results (default 50)"),
          offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)"),
          tag: z.string().optional().describe("Only recipes carrying this tag"),
        },
      },
      async ({ limit, offset, tag }) => {
        const result = await listRecipes(db(), { limit, offset, tag });
        return jsonResult(result);
      }
    );

    this.server.registerTool(
      "search_recipes",
      {
        title: "Search recipes",
        description:
          "Full-text search across titles, descriptions, ingredients, instructions, tags, and notes. " +
          "Matches word prefixes, so 'tomat' finds 'tomatoes'. Returns compact summaries ranked by relevance.",
        inputSchema: {
          query: z.string().min(1).describe("Search terms, e.g. 'chicken lime' or an ingredient"),
          limit: z.number().int().min(1).max(100).optional().describe("Max results (default 25)"),
        },
      },
      async ({ query, limit }) => {
        const recipes = await searchRecipes(db(), query, limit);
        return jsonResult({ recipes, query });
      }
    );

    this.server.registerTool(
      "get_recipe",
      {
        title: "Get a recipe",
        description: "Fetch one recipe in full (ingredients, instructions, notes) by its id.",
        inputSchema: {
          id: z.string().describe("Recipe id, e.g. 'rcp_a1b2c3d4e5'"),
        },
      },
      async ({ id }) => {
        const recipe = await getRecipe(db(), id);
        if (!recipe) return errorResult(`No recipe found with id '${id}'.`);
        return jsonResult(recipe);
      }
    );

    this.server.registerTool(
      "create_recipe",
      {
        title: "Create a recipe",
        description:
          "Save a new recipe to the recipe box. Returns the stored recipe including its generated id. " +
          "Before saving a recipe that may already exist, search_recipes to avoid duplicates.",
        inputSchema: {
          title: recipeFields.title,
          description: recipeFields.description.optional(),
          ingredients: recipeFields.ingredients.min(1),
          instructions: recipeFields.instructions.min(1),
          tags: recipeFields.tags.optional(),
          servings: recipeFields.servings.optional(),
          prep_time_minutes: recipeFields.prep_time_minutes.optional(),
          cook_time_minutes: recipeFields.cook_time_minutes.optional(),
          source: recipeFields.source.optional(),
          notes: recipeFields.notes.optional(),
          image_url: recipeFields.image_url.optional(),
          nutrition: recipeFields.nutrition.optional(),
        },
      },
      async (input) => {
        const recipe = await createRecipe(db(), input);
        return jsonResult(recipe);
      }
    );

    this.server.registerTool(
      "update_recipe",
      {
        title: "Update a recipe",
        description:
          "Update fields of an existing recipe. Only the fields provided change; array fields " +
          "(ingredients, instructions, tags) are replaced in full when provided. Returns the updated recipe.",
        inputSchema: {
          id: z.string().describe("Id of the recipe to update"),
          title: recipeFields.title.optional(),
          description: recipeFields.description.optional(),
          ingredients: recipeFields.ingredients.optional(),
          instructions: recipeFields.instructions.optional(),
          tags: recipeFields.tags.optional(),
          servings: recipeFields.servings.optional(),
          prep_time_minutes: recipeFields.prep_time_minutes.optional(),
          cook_time_minutes: recipeFields.cook_time_minutes.optional(),
          source: recipeFields.source.optional(),
          notes: recipeFields.notes.optional(),
          image_url: recipeFields.image_url.optional(),
          nutrition: recipeFields.nutrition
            .nullable()
            .optional()
            .describe("Per-serving nutrition estimate. Pass null to clear saved nutrition."),
        },
      },
      async ({ id, ...patch }) => {
        const recipe = await updateRecipe(db(), id, patch);
        if (!recipe) return errorResult(`No recipe found with id '${id}'.`);
        return jsonResult(recipe);
      }
    );

    this.server.registerTool(
      "delete_recipe",
      {
        title: "Delete a recipe",
        description:
          "Permanently delete a recipe by id. This cannot be undone — confirm with the user before " +
          "deleting unless they explicitly asked for the deletion.",
        inputSchema: {
          id: z.string().describe("Id of the recipe to delete"),
        },
      },
      async ({ id }) => {
        const deleted = await deleteRecipe(db(), id);
        if (!deleted) return errorResult(`No recipe found with id '${id}'.`);
        return jsonResult({ deleted: true, id });
      }
    );

    this.server.registerTool(
      "list_tags",
      {
        title: "List tags",
        description: "List every tag in use with its recipe count. Useful before filtering by tag.",
        inputSchema: {},
      },
      async () => {
        const tags = await listTags(db());
        return jsonResult({ tags });
      }
    );
  }
}
