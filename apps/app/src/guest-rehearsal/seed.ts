// ゲストのワークスペースに、事前に走らせたリハーサルの結果を入れる（15 §最初に入っているもの・D-97）。
// 用意した依頼（順番の編成全体）の1回分：12件の状況のうち10件は統制が止め、2件がすり抜け、締める提案が付く。防いだ損害・損害の式の値・合否は、
// build.test.ts が本物に近い世界（LLM だけ台本）で走らせて決めた値（fixture.json）。実行時に Gemini は呼ばない・usage_records・監査ログは足さない。
// 合格証は入れない（すり抜けがあるため）。審査員が [適用] を押すと、同じ状況で再試験が走り（ここで初めて Gemini が動く）、全件合格なら合格証が出る。
// 「押そうとしているルール」（候補のルール）は、送る前の確認の [以後も許可] と同じ形：山田珈琲への豆の発注は数量・単価を問わず確認なし。
// このルールで試したので、豆の大量発注・値上がりの発注の2件がすり抜ける（締める提案は数量・単価のガード）。呼び出しは1つのトランザクションの中（外部を呼ばない：G-14）

import { readFileSync } from "node:fs";
import { lockWorkspace, type Tx, type Uuid, type WsCtx } from "@open-team/db";
import { listConnectors, listConnectorTools } from "@open-team/db/app";
import { listMembers } from "@open-team/db/asks";
import { listRehearsalRuns } from "@open-team/db/rehearsal";
import { insertSeedRows } from "@open-team/db/seed";
import { grantedToolHashes } from "@open-team/edge";
import type { JsonObject } from "@open-team/kernel";
import type { AppDeps } from "../deps.ts";
import { OwnerSetupError } from "../owner-setup.ts";
import { decisionInputsHashOfRow, intentHashOfRow, type FixtureRow, type GuestRehearsalFixture } from "./fixture.ts";

let cached: GuestRehearsalFixture | null = null;
/** 事前に走らせた結果（fixture.json）。最初に使うときに読む */
export function loadGuestRehearsalFixture(): GuestRehearsalFixture {
  cached ??= JSON.parse(readFileSync(new URL("./fixture.json", import.meta.url), "utf8")) as GuestRehearsalFixture;
  return cached;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** 1件の状況の走る時間（状況の並びで時刻を割り当てる。実際の走行の長さではなく、結果の並びが分かる程度の間隔） */
const SCENARIO_STEP_MS = 25_000;
const SCENARIO_RUN_MS = 20_000;
/** 用意した依頼の1回分（12分前）より前に走り終えたことにする */
const RUN_STARTED_MINUTES_AGO = 40;

export type SeededRehearsal =
  | { created: false }
  | {
      created: true;
      runId: Uuid;
      /** すり抜けた状況（sim-world の走行を結びつける対象） */
      slipped: Array<{ scenarioId: Uuid; scenario: JsonObject }>;
    };

export async function seedPreparedRehearsal(
  tx: Tx,
  deps: Pick<AppDeps, "ids" | "env">,
  ctx: WsCtx & { userId: Uuid },
  team: { askId: Uuid },
  now: Date,
): Promise<SeededRehearsal> {
  await lockWorkspace(tx, ctx);
  if ((await listRehearsalRuns(tx, ctx, { subject: { askId: team.askId }, limit: 1 })).length > 0) return { created: false };
  const fx = loadGuestRehearsalFixture();

  // ---- 入れ先の本物の行（担当2人・スナップショット・コネクタ・ツール）----
  const members = (await listMembers(tx, ctx, team.askId)).filter((m) => !m.is_aggregator);
  const inbox = members.find((m) => m.position === 1);
  const buyer = members.find((m) => m.position === 2);
  if (!inbox || !buyer) throw new OwnerSetupError("agents", "用意した依頼の担当が2人そろっていない");
  const snapshotOf = async (agentId: Uuid): Promise<{ id: Uuid; policies: Record<string, { policy: unknown; hash: string }> }> => {
    const r = await tx.query<{ current_snapshot_id: Uuid; effective_policies: Record<string, { policy: unknown; hash: string }> }>(
      `SELECT a.current_snapshot_id, s.effective_policies FROM agents a JOIN agent_snapshots s ON s.workspace_id = a.workspace_id AND s.id = a.current_snapshot_id
        WHERE a.workspace_id = $1 AND a.id = $2`,
      [ctx.workspaceId, agentId],
    );
    const row = r.rows[0];
    if (!row) throw new OwnerSetupError("agents", "担当のスナップショットがない");
    return { id: row.current_snapshot_id, policies: row.effective_policies };
  };
  const inboxSnap = await snapshotOf(inbox.agent_id);
  const buyerSnap = await snapshotOf(buyer.agent_id);
  const connectors = await listConnectors(tx, ctx);
  const tools = await listConnectorTools(tx, ctx);
  const connectorOf = (slug: string) => {
    const c = connectors.find((x) => x.slug === slug);
    if (!c) throw new OwnerSetupError("connectors", `デモ用のコネクタがない：${slug}`);
    return c;
  };
  const toolHashOf = (slug: string, name: string) => {
    const t = tools.find((x) => x.connector_id === connectorOf(slug).id && x.name === name);
    if (!t) throw new OwnerSetupError("connectors", `デモ用のツールがない：${slug}.${name}`);
    return t.tool_hash;
  };
  const buyerPolicy = buyerSnap.policies.reorder as { policy: Parameters<typeof grantedToolHashes>[2]; hash: string } | undefined;
  if (!buyerPolicy) throw new OwnerSetupError("agents", "仕入れ係の仕事の実効ポリシーがない");
  const toolHashes = await grantedToolHashes(tx, ctx, buyerPolicy.policy);

  // ---- 仮の ID → 入れ先の ID（外の行は本物、中の行は新しい ID）----
  const idMap = new Map<string, Uuid>([
    [fx.refs.workspace, ctx.workspaceId],
    [fx.refs.user, ctx.userId],
    [fx.refs.ask, team.askId],
    [fx.refs.inbox.agent, inbox.agent_id],
    [fx.refs.inbox.job, inbox.job_id],
    [fx.refs.inbox.snapshot, inboxSnap.id],
    [fx.refs.inbox.member, inbox.id],
    [fx.refs.buyer.agent, buyer.agent_id],
    [fx.refs.buyer.job, buyer.job_id],
    [fx.refs.buyer.snapshot, buyerSnap.id],
    [fx.refs.buyer.member, buyer.id],
    ...Object.entries(fx.refs.connectors).map(([slug, id]): [string, Uuid] => [id, connectorOf(slug).id]),
  ]);
  const real = (u: string): Uuid => {
    let v = idMap.get(u);
    if (v === undefined) {
      v = deps.ids.newId();
      idMap.set(u, v);
    }
    return v;
  };
  // ツールの指紋：作ったときの値を入れ先の同じツールの値に置き換える（同じ manifest なら同じ値）
  const hashSwaps: Array<[string, string]> = [
    [fx.refs.toolHashes.place_order!, toolHashOf("supplier", "place_order")],
    [fx.refs.toolHashes.register_payee!, toolHashOf("bank", "register_payee")],
  ];

  // ---- 時刻 ----
  const runStart = new Date(now.getTime() - RUN_STARTED_MINUTES_AGO * 60_000);
  const startOf = (ordinal: number): Date => new Date(runStart.getTime() + (ordinal - 1) * SCENARIO_STEP_MS);
  const endOf = (ordinal: number): Date => new Date(startOf(ordinal).getTime() + SCENARIO_RUN_MS);
  const runEnd = endOf(fx.scenarios.length);
  const ordinalOfScenario = new Map(fx.scenarios.map((s) => [s.id as string, s.ordinal as number]));
  const ordinalOfTask = new Map(fx.tasks.map((t) => [t.id as string, ordinalOfScenario.get(t.rehearsal_scenario_id as string) ?? 1]));
  const START_COLUMNS = new Set(["created_at", "queued_at", "started_at"]);

  /** 行の仮の値（"@…"・仮の ID・ツールの指紋）を入れ先の値にする。時刻は ordinal の状況の時刻、null なら走行の時刻 */
  const materialize = (row: FixtureRow, ordinal: number | null): FixtureRow => {
    // 仮の ID・ツールの指紋を先に置き換え、そのあとで "@…" を値にする（値にした本物の ID を、仮の ID と取り違えて置き換えないように）
    let text = JSON.stringify(row).replace(UUID_RE, real);
    for (const [from, to] of hashSwaps) if (from !== to) text = text.split(from).join(to);
    const replaced = JSON.parse(text) as FixtureRow;
    const out: FixtureRow = {};
    for (const [k, v] of Object.entries(replaced)) {
      if (v === "@t") out[k] = (START_COLUMNS.has(k) ? (ordinal === null ? runStart : startOf(ordinal)) : ordinal === null ? runEnd : endOf(ordinal)).toISOString();
      else if (v === "@runStart") out[k] = runStart.toISOString();
      else if (v === "@runEnd") out[k] = runEnd.toISOString();
      else if (v === "@user") out[k] = ctx.userId;
      else if (v === "@agentModel") out[k] = deps.env.gemini.agentModel;
      else if (v === "@toolHashes") out[k] = toolHashes;
      else out[k] = v;
    }
    return out;
  };

  // ---- 入れる（試験 → 走行 → 状況 → すり抜けたもののタスク・Intent・判定）----
  await insertSeedRows(tx, ctx, "rehearsal_cases", fx.cases.map((r) => materialize(r, null)));
  await insertSeedRows(tx, ctx, "rehearsal_runs", [materialize(fx.run, null)]);
  await insertSeedRows(tx, ctx, "rehearsal_scenarios", fx.scenarios.map((r) => materialize(r, r.ordinal as number)));
  await insertSeedRows(tx, ctx, "tasks", fx.tasks.map((r) => materialize(r, ordinalOfTask.get(r.id as string) ?? 1)));
  const intents = fx.intents.map((r) => materialize(r, ordinalOfTask.get(r.task_id as string) ?? 1));
  // 指紋は入れ先のコネクタ・ツールの値で作り直す
  for (const i of intents) i.intent_hash = intentHashOfRow(i);
  await insertSeedRows(tx, ctx, "action_intents", intents);
  const decisions = fx.decisions.map((r) => materialize(r, ordinalOfTask.get(r.task_id as string) ?? 1));
  for (const d of decisions) d.inputs_hash = decisionInputsHashOfRow(d);
  await insertSeedRows(tx, ctx, "policy_decisions", decisions);

  const slipped = fx.slippedScenarioIds.map((id) => {
    const row = fx.scenarios.find((s) => s.id === id)!;
    return { scenarioId: real(id), scenario: row.scenario as JsonObject };
  });
  return { created: true, runId: real(fx.run.id as string), slipped };
}
