-- Adds optional image and nutrition fields to databases created before
-- these columns existed in schema.sql. Fresh databases don't need this —
-- schema.sql already includes both columns.
--
-- Apply with:
--   npx wrangler d1 execute recipes-db --local  --file=./migrations/0002_image_nutrition.sql
--   npx wrangler d1 execute recipes-db --remote --file=./migrations/0002_image_nutrition.sql

ALTER TABLE recipes ADD COLUMN image_url TEXT NOT NULL DEFAULT '';
ALTER TABLE recipes ADD COLUMN nutrition TEXT;
