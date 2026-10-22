// 試験だけの binding（vitest.config.ts の miniflare.bindings）
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
