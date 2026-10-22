// Worker の試験は workerd の中で動かす（@cloudflare/vitest-plugin。設定は wrangler.jsonc を読む）
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
});
