-- Recipe storage schema for Cloudflare D1 (SQLite).
--
-- Apply with:
--   npx wrangler d1 execute recipes-db --local  --file=./schema.sql   (local dev)
--   npx wrangler d1 execute recipes-db --remote --file=./schema.sql   (production)

CREATE TABLE IF NOT EXISTS recipes (
  id                TEXT PRIMARY KEY,            -- short random id, e.g. "rcp_a1b2c3d4"
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  ingredients       TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
  instructions      TEXT NOT NULL DEFAULT '[]',  -- JSON array of step strings
  tags              TEXT NOT NULL DEFAULT '[]',  -- JSON array of lowercase strings
  servings          TEXT NOT NULL DEFAULT '',
  prep_time_minutes INTEGER,
  cook_time_minutes INTEGER,
  source            TEXT NOT NULL DEFAULT '',    -- URL or free text ("Grandma", "NYT Cooking", ...)
  notes             TEXT NOT NULL DEFAULT '',
  image_url         TEXT NOT NULL DEFAULT '',    -- optional photo URL (https)
  nutrition         TEXT,                        -- optional JSON object, per-serving (see src/types.ts Nutrition)
  created_at        TEXT NOT NULL,               -- ISO 8601
  updated_at        TEXT NOT NULL                -- ISO 8601
);

CREATE INDEX IF NOT EXISTS idx_recipes_updated_at ON recipes (updated_at DESC);

-- Full-text search over the searchable fields, kept in sync by triggers.
-- External-content FTS5 table: stores only the index, rows live in `recipes`.
CREATE VIRTUAL TABLE IF NOT EXISTS recipes_fts USING fts5(
  title,
  description,
  ingredients,
  instructions,
  tags,
  notes,
  content='recipes',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS recipes_fts_insert AFTER INSERT ON recipes BEGIN
  INSERT INTO recipes_fts(rowid, title, description, ingredients, instructions, tags, notes)
  VALUES (new.rowid, new.title, new.description, new.ingredients, new.instructions, new.tags, new.notes);
END;

CREATE TRIGGER IF NOT EXISTS recipes_fts_delete AFTER DELETE ON recipes BEGIN
  INSERT INTO recipes_fts(recipes_fts, rowid, title, description, ingredients, instructions, tags, notes)
  VALUES ('delete', old.rowid, old.title, old.description, old.ingredients, old.instructions, old.tags, old.notes);
END;

CREATE TRIGGER IF NOT EXISTS recipes_fts_update AFTER UPDATE ON recipes BEGIN
  INSERT INTO recipes_fts(recipes_fts, rowid, title, description, ingredients, instructions, tags, notes)
  VALUES ('delete', old.rowid, old.title, old.description, old.ingredients, old.instructions, old.tags, old.notes);
  INSERT INTO recipes_fts(rowid, title, description, ingredients, instructions, tags, notes)
  VALUES (new.rowid, new.title, new.description, new.ingredients, new.instructions, new.tags, new.notes);
END;
