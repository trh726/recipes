-- Durable indexing outbox. Safe to reapply; also queues existing recipes.
-- npx wrangler d1 execute recipes-db --remote --file=./migrations/0003_semantic_search.sql
CREATE TABLE IF NOT EXISTS recipe_search_jobs (
  recipe_id TEXT PRIMARY KEY,
  revision TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL DEFAULT 0
);

CREATE TRIGGER IF NOT EXISTS recipes_search_insert AFTER INSERT ON recipes BEGIN
  INSERT INTO recipe_search_jobs(recipe_id) VALUES (new.id)
  ON CONFLICT(recipe_id) DO UPDATE SET revision = lower(hex(randomblob(16))), next_attempt = 0;
END;

CREATE TRIGGER IF NOT EXISTS recipes_search_update AFTER UPDATE ON recipes BEGIN
  INSERT INTO recipe_search_jobs(recipe_id) VALUES (new.id)
  ON CONFLICT(recipe_id) DO UPDATE SET revision = lower(hex(randomblob(16))), next_attempt = 0;
END;

-- No foreign key: deleted ids must remain queued until removed from Vectorize.
CREATE TRIGGER IF NOT EXISTS recipes_search_delete AFTER DELETE ON recipes BEGIN
  INSERT INTO recipe_search_jobs(recipe_id) VALUES (old.id)
  ON CONFLICT(recipe_id) DO UPDATE SET revision = lower(hex(randomblob(16))), next_attempt = 0;
END;

INSERT INTO recipe_search_jobs(recipe_id) SELECT id FROM recipes WHERE true
ON CONFLICT(recipe_id) DO UPDATE SET revision = lower(hex(randomblob(16))), next_attempt = 0;
