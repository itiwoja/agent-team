// オーナーの初期投入（G-08）。偽の gateway（EP-51）と、同じプロセスの本物の sim-world（管理 API）で試す
import type { Db } from "@open-team/db";
import { useTestDb } from "@open-team/db/testing";
import { effectivePolicyHash, toolHashOf, type EffectivePolicy, type Json } from "@open-team/kernel";
import { SHOP_CONNECTORS, SHOP_TOOL_DESCRIPTIONS, SHOP_TOOL_INPUT_SCHEMAS } from "@open-team/sim-core";
import { describe, expect, it } from "vitest";
import { ensureOwnerWorkspace, OwnerSetupError, PREPARED_ASK_SEED_KEY } from "./owner-setup.ts";
import { SIM_URL, T0, fakeGatewayClient, inProcessSimWorld, makeTestApp, send, sendInternal, signInOwner } from "./test-helpers.ts";

const T = useTestDb();

function setup(db: Db, env: Parameters<typeof makeTestApp>[1] = {}) {
  const gateway = fakeGatewayClient(db);
  const sim = inProcessSimWorld();
  const t = makeTestApp(db, { ...env, deps: { gatewayClient: gateway, simClient: sim.simClient, ...env.deps } });
  return { t, gateway, sim };
}

/** 投入した行の数（2回目で増えないこと） */
async function counts(db: Db) {
  const tables = ["workspaces", "users", "memberships", "workspace_policies", "connectors", "connector_tools", "agents", "agent_snapshots", "agent_jobs", "asks", "ask_members", "audit_logs"];
  const out: Record<string, number> = {};
  for (const name of tables) out[name] = (await db.query<{ n: number }>(`SELECT count(*) AS n FROM ${name}`)).rows[0]?.n ?? -1;
  return out;
}

describe("ensureOwnerWorkspace（G-08）", () => {
  it("1回目で全部入り、2回目は同じ（行・ID・監査ログが増えない、作ったものは空）", async () => {
    const { db } = T();
    const { t, gateway, sim } = setup(db);
    const first = await ensureOwnerWorkspace(t.deps);
    expect(first.created).toMatchObject({
      workspace: true,
      policy: true,
      connectors: ["store", "supplier", "mail", "bank"],
      agents: ["受信箱係", "仕入れ係"],
      jobs: ["受信箱係/read-supplier-mail", "仕入れ係/reorder"],
      ask: true,
    });
    expect(first.created.classifiedTools.sort()).toEqual(
      ["bank.register_payee", "mail.list_inbox", "mail.send", "store.get_inventory", "supplier.list_products", "supplier.place_order"].sort(),
    );
    expect(first.demoStore.created).toBe(true);
    expect(first.needsReview).toEqual([]);
    const after1 = await counts(db);
    expect(after1).toMatchObject({
      workspaces: 1,
      workspace_policies: 1,
      connectors: 4,
      connector_tools: 6,
      agents: 2,
      agent_snapshots: 2,
      agent_jobs: 2,
      asks: 1,
      ask_members: 2,
    });

    const second = await ensureOwnerWorkspace(t.deps);
    expect(second.created).toEqual({
      workspace: false,
      policy: false,
      connectors: [],
      connectorsUpdated: [],
      classifiedTools: [],
      agents: [],
      jobs: [],
      ask: false,
    });
    expect(second.demoStore).toEqual({ executionId: first.demoStore.executionId, created: false });
    expect(second.askId).toBe(first.askId);
    expect(second.agents).toEqual(first.agents);
    expect(await counts(db)).toEqual(after1);
    // 同期は毎回呼ぶ（起動時の tools/list で変化を見つける：EP-51）
    expect(gateway.syncCalls).toHaveLength(8);
    expect(sim.requests.filter((r) => r.startsWith("POST /admin/v1/demo-store"))).toHaveLength(2);
  });

  it("ポリシーは kernel のオーナーの既定（per_day_usd 10・mcp_write approve・コネクタ4つ）", async () => {
    const { db } = T();
    const { t } = setup(db);
    const r = await ensureOwnerWorkspace(t.deps);
    const p = await db.query<{ policy: { budget: { per_day_usd: number }; autonomy: Record<string, string>; connectors: { enabled: string[] } } }>(
      "SELECT policy FROM workspace_policies WHERE workspace_id = $1",
      [r.workspaceId],
    );
    expect(p.rows[0]?.policy.budget.per_day_usd).toBe(10);
    expect(p.rows[0]?.policy.autonomy.mcp_write).toBe("approve");
    expect(p.rows[0]?.policy.connectors.enabled).toEqual(["bank", "mail", "store", "supplier"]);
  });

  it("コネクタは SIM_WORLD_URL ＋ path、local の認証は none（cloud は sa-app の ID トークン）", async () => {
    const { db } = T();
    const { t } = setup(db);
    await ensureOwnerWorkspace(t.deps);
    const rows = await db.query<{ slug: string; url: string; auth: unknown; kind: string }>("SELECT slug, url, auth, kind FROM connectors ORDER BY slug");
    expect(rows.rows).toEqual(
      ["bank", "mail", "store", "supplier"].map((slug) => ({ slug, url: `${SIM_URL}/mcp/shop/${slug}`, auth: { type: "none" }, kind: "sim" })),
    );
    const cloud = setup(db, { env: { deploymentMode: "cloud", simWorldUrl: "https://sim-world-1.run.app" } });
    const r = await ensureOwnerWorkspace(cloud.t.deps);
    expect(r.created.connectorsUpdated).toEqual(["store", "supplier", "mail", "bank"]);
    const updated = await db.query<{ url: string; auth: unknown }>("SELECT url, auth FROM connectors WHERE slug = 'supplier'");
    expect(updated.rows[0]).toEqual({
      url: "https://sim-world-1.run.app/mcp/shop/supplier",
      auth: { type: "gcp_id_token", audience: "https://sim-world-1.run.app" },
    });
  });

  it("manifest の分類・引数の役割を確定し、tool_hash = toolHashOf(説明・スキーマ・役割)（MT §3.14 の7）。classified_by は system:seed", async () => {
    const { db } = T();
    const { t } = setup(db);
    await ensureOwnerWorkspace(t.deps);
    const rows = await db.query<{ connector: string; name: string; classification: string; arg_roles: Record<string, string>; tool_hash: string; classified_by: string }>(
      `SELECT c.slug AS connector, t.name, t.classification, t.arg_roles, t.tool_hash, t.classified_by
         FROM connector_tools t JOIN connectors c ON c.id = t.connector_id ORDER BY c.slug, t.name`,
    );
    for (const m of SHOP_CONNECTORS) {
      for (const tool of m.tools) {
        const row = rows.rows.find((r) => r.connector === m.slug && r.name === tool.name);
        const key = `${m.slug}.${tool.name}` as keyof typeof SHOP_TOOL_DESCRIPTIONS;
        expect(row).toEqual({
          connector: m.slug,
          name: tool.name,
          classification: tool.classification,
          arg_roles: tool.argRoles,
          tool_hash: toolHashOf({ description: SHOP_TOOL_DESCRIPTIONS[key], inputSchema: SHOP_TOOL_INPUT_SCHEMAS[key] as unknown as Json, argRoles: tool.argRoles }),
          classified_by: "system:seed",
        });
      }
    }
  });

  it("2体の担当（M-36：仕入れ係に bank.register_payee、mail.send は付けない）。スナップショットの実効ポリシーとハッシュは compose の結果。ルールは入れない（G-04）", async () => {
    const { db } = T();
    const { t } = setup(db);
    const r = await ensureOwnerWorkspace(t.deps);
    const agents = await db.query<{ name: string; status: string; slug: string; definition: { grants: { connectors: Record<string, { grant: string[] }> }; rules: unknown[] }; effective_policies: Record<string, { policy: EffectivePolicy; hash: string }> }>(
      `SELECT a.name, a.status, a.slug, s.definition, s.effective_policies
         FROM agents a JOIN agent_snapshots s ON s.id = a.current_snapshot_id ORDER BY a.name`,
    );
    const purchasing = agents.rows.find((x) => x.name === "仕入れ係");
    const inbox = agents.rows.find((x) => x.name === "受信箱係");
    expect(purchasing?.status).toBe("active");
    expect(purchasing?.slug).toMatch(/^a-[0-9a-f]{8}$/);
    expect(purchasing?.definition.grants.connectors).toEqual({
      bank: { grant: ["register_payee"] },
      store: { grant: ["get_inventory"] },
      supplier: { grant: ["list_products", "place_order"] },
    });
    expect(inbox?.definition.grants.connectors).toEqual({ mail: { grant: ["list_inbox"] } });
    for (const a of agents.rows) {
      expect(a.definition.rules).toEqual([]);
      for (const e of Object.values(a.effective_policies)) {
        expect(e.hash).toBe(effectivePolicyHash(e.policy));
        expect(e.policy.rules.items).toEqual([]);
      }
    }
    expect(purchasing?.effective_policies.reorder?.policy.mcp.grants).toEqual({
      bank: ["register_payee"],
      store: ["get_inventory"],
      supplier: ["list_products", "place_order"],
    });
    expect(Object.keys(inbox?.effective_policies ?? {})).toEqual(["read-supplier-mail"]);
    expect(r.agents.map((x) => x.name)).toEqual(["受信箱係", "仕入れ係"]);
  });

  it("順番の依頼（chain・毎日18時 Asia/Tokyo・next_run_at は次の18時 JST・seed_key）と担当の段", async () => {
    const { db } = T();
    const { t } = setup(db);
    const r = await ensureOwnerWorkspace(t.deps);
    const ask = await db.query<{ status: string; shape: string; trigger: unknown; next_run_at: Date; seed_key: string; text: string; created_by: string }>(
      "SELECT status, shape, trigger, next_run_at, seed_key, text, created_by FROM asks WHERE id = $1",
      [r.askId],
    );
    expect(ask.rows[0]).toEqual({
      status: "running",
      shape: "chain",
      trigger: { type: "schedule", cron: "0 18 * * *", timezone: "Asia/Tokyo" },
      // T0 は 10:00 JST → 同じ日の 18:00 JST（09:00 UTC）
      next_run_at: new Date("2026-10-14T09:00:00.000Z"),
      seed_key: PREPARED_ASK_SEED_KEY,
      text: "仕入れ先のメールを読んで、在庫を見て、必要なら発注して",
      created_by: r.ownerUserId,
    });
    const members = await db.query<{ position: number; depends_on: number[]; is_spokesperson: boolean; agent_id: string; job_id: string }>(
      "SELECT position, depends_on, is_spokesperson, agent_id, job_id FROM ask_members WHERE ask_id = $1 ORDER BY position",
      [r.askId],
    );
    expect(members.rows).toEqual([
      { position: 1, depends_on: [], is_spokesperson: false, agent_id: r.agents[0]?.agentId, job_id: r.agents[0]?.jobId },
      { position: 2, depends_on: [1], is_spokesperson: true, agent_id: r.agents[1]?.agentId, job_id: r.agents[1]?.jobId },
    ]);
  });

  it("監査ログは作ったものだけ（origin: seed）で、ハッシュチェーンが通る。2回目は増えない", async () => {
    const { db } = T();
    const { t } = setup(db);
    const r = await ensureOwnerWorkspace(t.deps);
    const logs = await db.query<{ event_type: string; payload: Record<string, unknown> }>("SELECT event_type, payload FROM audit_logs WHERE workspace_id = $1 ORDER BY seq", [r.workspaceId]);
    const types = logs.rows.map((x) => x.event_type);
    expect(types[0]).toBe("workspace.created");
    expect(types.filter((x) => x === "connector.registered")).toHaveLength(4);
    expect(types.filter((x) => x === "connector.tool.classified")).toHaveLength(6);
    expect(types.filter((x) => x === "agent.created")).toHaveLength(2);
    expect(types.filter((x) => x === "job.created")).toHaveLength(2);
    expect(types).toContain("policy.snapshot_created");
    expect(types).toContain("ask.created");
    expect(logs.rows.slice(1).every((x) => x.payload.origin === "seed")).toBe(true);
    // 監査ログの検証（EP-44）もこのワークスペースで通る
    const a = await signInOwner(t);
    const v = await send(t, "POST", `/api/v1/workspaces/${a.workspaceId}/audit-logs/verify`, { cookie: a.cookie, csrf: a.csrf, body: {} });
    expect(await v.json()).toMatchObject({ ok: true, checkedCount: logs.rows.length });
  });

  it("入口で先にできたオーナーのワークスペースに足していく（同じワークスペース）", async () => {
    const { db } = T();
    const { t } = setup(db);
    const a = await signInOwner(t);
    const r = await ensureOwnerWorkspace(t.deps);
    expect(r.workspaceId).toBe(a.workspaceId);
    expect(r.created.workspace).toBe(false);
  });

  it("同時に2回呼んでも二重に作らない", async () => {
    const { db } = T();
    const { t } = setup(db);
    const [x, y] = await Promise.all([ensureOwnerWorkspace(t.deps), ensureOwnerWorkspace(t.deps)]);
    expect(x.askId).toBe(y.askId);
    expect(await counts(db)).toMatchObject({ workspaces: 1, connectors: 4, connector_tools: 6, agents: 2, asks: 1, ask_members: 2 });
  });

  it("needs_review のツール（サーバーの説明が変わった）は確定しない・書き換えない。結果に出す", async () => {
    const { db } = T();
    const { t, gateway } = setup(db);
    await ensureOwnerWorkspace(t.deps);
    const before = await db.query<{ tool_hash: string }>("SELECT tool_hash FROM connector_tools WHERE name = 'place_order'");
    gateway.overrideDescription("supplier.place_order", "説明が変わった（F-08）");
    const r = await ensureOwnerWorkspace(t.deps);
    expect(r.needsReview).toEqual(["supplier.place_order"]);
    const after = await db.query<{ status: string; tool_hash: string; classification: string }>("SELECT status, tool_hash, classification FROM connector_tools WHERE name = 'place_order'");
    expect(after.rows[0]).toEqual({ status: "needs_review", tool_hash: before.rows[0]?.tool_hash, classification: "write" });
  });

  it("manifest のツールが tools/list にない → manifest の手順で止まる（担当・依頼は作らない）", async () => {
    const { db } = T();
    const { t, gateway } = setup(db);
    gateway.omit("bank.register_payee");
    const e = await ensureOwnerWorkspace(t.deps).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(OwnerSetupError);
    expect((e as OwnerSetupError).step).toBe("manifest");
    expect(await counts(db)).toMatchObject({ agents: 0, asks: 0 });
  });

  it("gateway に届かない → sync の手順、sim-world に届かない → demo_store の手順で止まり、直ってからの呼び直しで最後まで入る", async () => {
    const { db } = T();
    const { t, gateway, sim } = setup(db);
    gateway.failNext(503, "UNAVAILABLE");
    expect(((await ensureOwnerWorkspace(t.deps).catch((x: unknown) => x)) as OwnerSetupError).step).toBe("sync");
    sim.setDown(true);
    expect(((await ensureOwnerWorkspace(t.deps).catch((x: unknown) => x)) as OwnerSetupError).step).toBe("demo_store");
    sim.setDown(false);
    const r = await ensureOwnerWorkspace(t.deps);
    expect(r.created.agents).toEqual(["受信箱係", "仕入れ係"]);
    expect(await counts(db)).toMatchObject({ connectors: 4, connector_tools: 6, agents: 2, asks: 1 });
  });

  it("SIM_WORLD_URL がない → env の手順で止まる（何も作らない）", async () => {
    const { db } = T();
    const { t } = setup(db, { env: { simWorldUrl: undefined } });
    expect(((await ensureOwnerWorkspace(t.deps).catch((x: unknown) => x)) as OwnerSetupError).step).toBe("env");
    expect((await counts(db)).workspaces).toBe(0);
  });

  it("次の18時は、18時ちょうど・過ぎたら翌日（JST）", async () => {
    const { db } = T();
    const { t } = setup(db);
    const r = await ensureOwnerWorkspace(t.deps, { now: new Date("2026-10-14T09:00:00.000Z") });
    const ask = await db.query<{ next_run_at: Date }>("SELECT next_run_at FROM asks WHERE id = $1", [r.askId]);
    expect(ask.rows[0]?.next_run_at).toEqual(new Date("2026-10-15T09:00:00.000Z"));
  });
});

describe("POST /internal/setup/owner-workspace", () => {
  it("sa-app の証明で呼べる（結果の JSON）。証明なし → 403", async () => {
    const { db } = T();
    const { t } = setup(db);
    expect((await sendInternal(t, "POST", "/internal/setup/owner-workspace", null)).status).toBe(403);
    const res = await sendInternal(t, "POST", "/internal/setup/owner-workspace");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { askId: string; created: { ask: boolean } };
    expect(body.created.ask).toBe(true);
    const again = (await (await sendInternal(t, "POST", "/internal/setup/owner-workspace")).json()) as { askId: string; created: { ask: boolean } };
    expect(again).toMatchObject({ askId: body.askId, created: { ask: false } });
  });

  it("sim-world に届かない → 503 SIM_WORLD_UNAVAILABLE（details.step）", async () => {
    const { db } = T();
    const { t, sim } = setup(db);
    sim.setDown(true);
    const res = await sendInternal(t, "POST", "/internal/setup/owner-workspace");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string; details: unknown } }).error).toMatchObject({
      code: "SIM_WORLD_UNAVAILABLE",
      details: { step: "demo_store" },
    });
  });

  it("T0 の時計で作ったデモ店舗は sim-world の管理 API で読める（sim-client の往復）", async () => {
    const { db } = T();
    const { t, sim } = setup(db);
    const r = await ensureOwnerWorkspace(t.deps);
    const got = await sim.simClient.getExecution({ workspaceId: r.workspaceId, executionId: r.demoStore.executionId });
    expect(got.execution).toMatchObject({ variant: "live", rehearsalRunId: null, workspaceId: r.workspaceId });
    const snap = await sim.simClient.createSnapshot({ workspaceId: r.workspaceId, world: "shop", sourceTaskId: "44444444-4444-4444-8444-444444444444" });
    expect(snap.snapshot.executionId).toBe(r.demoStore.executionId);
    expect(T0.toISOString()).toBe("2026-10-14T01:00:00.000Z");
  });
});
