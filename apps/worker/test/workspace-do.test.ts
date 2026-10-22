import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, type WorkspaceDO } from "../src/workspace-do.ts";

describe("Worker の土台", () => {
  it("GET /api/health", async () => {
    const res = await exports.default.fetch("https://makase.test/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("WorkspaceDO は作られたときにスキーマを最後の版まで当て、2回目は当て直さない", async () => {
    const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName("ws-1"));
    const last = MIGRATIONS[MIGRATIONS.length - 1]!.version;
    expect(await stub.schemaVersion()).toBe(last);
    await runInDurableObject(stub, (instance: WorkspaceDO, state) => {
      const rows = state.storage.sql.exec<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version").toArray();
      expect(rows.map((r) => r.version)).toEqual(MIGRATIONS.map((m) => m.version));
      expect(instance.schemaVersion()).toBe(last);
    });
  });
});
