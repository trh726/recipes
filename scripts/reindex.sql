-- Queue all existing recipes again without disturbing in-flight indexing.
INSERT INTO recipe_search_jobs(recipe_id) SELECT id FROM recipes WHERE true
ON CONFLICT(recipe_id) DO UPDATE SET revision = lower(hex(randomblob(16))), next_attempt = 0;
