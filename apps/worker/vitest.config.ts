// Worker の試験は workerd の中で動かす（@cloudflare/vitest-plugin。設定は wrangler.jsonc を読む）
// D1 のマイグレーションは試験だけの binding（TEST_MIGRATIONS）で渡し、test/apply-migrations.ts が当てる
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
          APP_BASE_URL: "https://makase.test",
          GOOGLE_CLIENT_ID: "client-id.test",
          GOOGLE_CLIENT_SECRET: "client-secret.test",
          ALLOWED_EMAILS: "owner@example.com, Second@Example.com",
        },
      },
    })),
  ],
  test: { setupFiles: ["./test/apply-migrations.ts"] },
});
