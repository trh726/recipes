-- Optional sample data so the app isn't empty on first run.
-- Apply with:
--   npx wrangler d1 execute recipes-db --local  --file=./seed.sql
--   npx wrangler d1 execute recipes-db --remote --file=./seed.sql

INSERT OR IGNORE INTO recipes
  (id, title, description, ingredients, instructions, tags, servings,
   prep_time_minutes, cook_time_minutes, source, notes, created_at, updated_at)
VALUES
  (
    'rcp_seed000001',
    'Weeknight Chickpea Curry',
    'A pantry-friendly coconut chickpea curry that comes together in one pot.',
    '["2 tbsp neutral oil","1 yellow onion, diced","3 cloves garlic, minced","1 tbsp grated ginger","2 tbsp curry powder","1 can (400ml) coconut milk","2 cans chickpeas, drained","1 can crushed tomatoes","1 tsp salt","Handful of spinach","Cooked rice, to serve"]',
    '["Heat the oil in a large pot over medium heat and soften the onion, about 5 minutes.","Add garlic, ginger, and curry powder; cook until fragrant, about 1 minute.","Stir in coconut milk, chickpeas, crushed tomatoes, and salt. Simmer 15 minutes.","Fold in the spinach until wilted. Taste and adjust salt.","Serve over rice."]',
    '["dinner","vegetarian","quick","one-pot"]',
    '4 servings',
    10, 20,
    '',
    'Swap spinach for kale if that''s what''s around — just simmer a few minutes longer.',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z'
  ),
  (
    'rcp_seed000002',
    'Brown Butter Chocolate Chip Cookies',
    'Chewy centers, crisp edges, and the nutty depth of browned butter.',
    '["225g unsalted butter","300g all-purpose flour","1 tsp baking soda","1 tsp kosher salt","200g dark brown sugar","100g granulated sugar","2 large eggs","2 tsp vanilla extract","250g chocolate chips","Flaky salt, for topping"]',
    '["Brown the butter in a saucepan over medium heat until nutty and golden; cool 15 minutes.","Whisk flour, baking soda, and salt in a bowl.","Beat the cooled butter with both sugars, then beat in eggs and vanilla.","Fold in the dry ingredients, then the chocolate chips. Chill the dough 30 minutes.","Scoop onto lined sheets, top with flaky salt, and bake at 190°C (375°F) for 10-12 minutes."]',
    '["dessert","baking","cookies"]',
    '24 cookies',
    20, 12,
    '',
    'Chilling overnight makes them even better.',
    '2026-01-02T00:00:00.000Z',
    '2026-01-02T00:00:00.000Z'
  );
