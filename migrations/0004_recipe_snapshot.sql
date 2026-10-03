-- A single revision changes atomically with every recipe write, including SQL
-- edits outside MCP. The publisher checks one row instead of scanning recipes.
CREATE TABLE IF NOT EXISTS recipe_publication (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO recipe_publication(id, revision) VALUES (1, 1);

CREATE TRIGGER IF NOT EXISTS recipes_publish_insert AFTER INSERT ON recipes BEGIN
  UPDATE recipe_publication SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS recipes_publish_update AFTER UPDATE ON recipes BEGIN
  UPDATE recipe_publication SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS recipes_publish_delete AFTER DELETE ON recipes BEGIN
  UPDATE recipe_publication SET revision = revision + 1 WHERE id = 1;
END;
