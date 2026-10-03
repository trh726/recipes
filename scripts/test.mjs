import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const directory = await mkdtemp(join(tmpdir(), "recipe-search-tests-"));
try {
  const outfile = join(directory, "search.test.mjs");
  await build({ entryPoints: ["tests/search.test.ts"], bundle: true, platform: "node", format: "esm", outfile });
  const result = spawnSync(process.execPath, ["--test", outfile, "tests/recipe-cache.test.mjs", "tests/scaling.test.mjs", "tests/structured-data.test.mjs"], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
