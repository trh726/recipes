import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

export default defineConfig({
  site: "https://recipes.heuermann.xyz",
  output: "server",
  session: false,
  // Prebundle runtime-selected modules before workerd starts. Discovering them
  // mid-startup otherwise invalidates chunks already loaded by the Worker.
  vite: { optimizeDeps: { include: ["astro/assets/services/noop", "astro/logger/console"] } },
  adapter: cloudflare({ imageService: "passthrough" }),
});
