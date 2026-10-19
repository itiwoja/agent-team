// 却下した書き込みの回帰の試験（incident・user_reject）の行に添える注記（D-108・D-110）。
// O-08 は「却下したのと同じ宛先・同じ内容」の書き込みだけを fail にする。同じ宛先で内容の違う書き込みが、
// 以後も許可のルールで確認なしに通ったときは合否を変えず、行に「何が送られたか」を添える（元の値まで開ける：R-73・BR-79）。
// 読むときに作る（保存済みの値だけ。LLM なし・世界への問い合わせなし）。仕入れ先と品目の名前は世界の基準の値（SHOP_BASELINE）から引く

import type { RehearsalCaseRow, RehearsalRunRow, RehearsalScenarioRow, WsCtx } from "@open-team/db";
import { getAgentSnapshotRow } from "@open-team/db/edge";
import { getRehearsalCase } from "@open-team/db/rehearsal";
import { listRuleAllowedWritesOfScenarios, type RuleAllowedWrite } from "@open-team/db/rehearsal-tighten";
import type { Json, JsonObject, StoppedWrite } from "@open-team/kernel";
import { SHOP_BASELINE, findToolManifest } from "@open-team/sim-core";
import { KNOWN_CONNECTORS } from "../connectors/known.ts";
import type { AppDeps } from "../deps.ts";
import { ruleIndexOf, shopRuleLabelsOf } from "./tighten-apply.ts";

/** 注記の品目1行（数量・単価は引数のまま。名前と単位は基準の値から。分からなければ null） */
export interface NoteItem {
  sku: string | null;
  name: string | null;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
}

export interface IncidentNoteView {
  /** 画面にそのまま出す1文 */
  text: string;
  /** 宛先の名前（仕入れ先なら山田珈琲など）。分からなければ null */
  destination: string | null;
  /** 通したルールの中身（「山田珈琲への発注は以後も許可」）。内部の ID は出さない */
  ruleLabel: string | null;
  /** 今回送られた内容と、却下した内容（元の値） */
  sent: NoteItem[];
  rejected: NoteItem[];
}

function itemsOf(args: JsonObject): NoteItem[] {
  const raw = args.items;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((it) => {
    if (it === null || typeof it !== "object" || Array.isArray(it)) return [];
    const o = it as JsonObject;
    const sku = typeof o.sku === "string" ? o.sku : null;
    const product = sku === null ? undefined : SHOP_BASELINE.products.find((p) => p.sku === sku);
    return [
      {
        sku,
        name: product?.name ?? null,
        quantity: typeof o.quantity === "number" ? o.quantity : null,
        unit: product?.unit ?? null,
        unitPrice: typeof o.unit_price === "number" ? o.unit_price : null,
      },
    ];
  });
}

function qtyText(items: readonly NoteItem[]): string {
  return items.map((i) => (i.quantity === null ? "?" : `${i.quantity}${i.unit ?? ""}`)).join("・");
}

function summaryOf(sent: readonly NoteItem[], rejected: readonly NoteItem[]): string | null {
  if (sent.length === 0 || rejected.length === 0) return null;
  const now = qtyText(sent);
  const before = qtyText(rejected);
  if (now !== before) return `今回 ${now}・却下したのは ${before}`;
  const price = (items: readonly NoteItem[]) => items.map((i) => (i.unitPrice === null ? "?" : `${i.unitPrice}円`)).join("・");
  return `今回 単価 ${price(sent)}・却下したのは 単価 ${price(rejected)}`;
}

function supplierNameOf(args: JsonObject): string | null {
  const id = args.supplier_id;
  if (typeof id !== "string") return null;
  return SHOP_BASELINE.suppliers.find((s) => s.id === id)?.name ?? null;
}

/**
 * 注記を作る（純粋）。却下（user_reject）した書き込みと、同じ操作・同じ宛先で内容（optionDigest）が違い、ルールで通った書き込みの最初の1組。
 * 同じ内容の組は O-08 が fail にするので注記の対象外。組がなければ null
 */
export function incidentNoteOf(
  stoppedWrites: readonly StoppedWrite[],
  writes: readonly RuleAllowedWrite[],
  ruleOf: (w: RuleAllowedWrite) => { id: string; action: string; match?: Readonly<Record<string, Json>> } | null,
): IncidentNoteView | null {
  for (const sw of stoppedWrites) {
    if (sw.stoppedBy !== "user_reject") continue;
    const w = writes.find((x) => x.action === sw.action && x.destinationKey === sw.destinationKey && x.optionDigest !== sw.optionDigest);
    if (w === undefined) continue;
    const noun = findToolManifest(KNOWN_CONNECTORS, w.action.replace(/^mcp\./, ""))?.tool.actionNoun ?? "書き込み";
    const destination = supplierNameOf(w.arguments) ?? supplierNameOf(sw.argumentsSnapshot);
    const rule = ruleOf(w);
    const ruleLabel = rule === null ? null : (shopRuleLabelsOf([rule], [SHOP_BASELINE])[rule.id] ?? null);
    const sent = itemsOf(w.arguments);
    const rejected = itemsOf(sw.argumentsSnapshot);
    const summary = summaryOf(sent, rejected);
    const text =
      `あなたが送らなかった${noun}と同じ宛先${destination === null ? "" : `（${destination}）`}への${noun}が、` +
      `${ruleLabel === null ? "以後も許可のルール" : `「${ruleLabel}」のルール`}で確認なしに送られました` +
      `${summary === null ? "" : `（${summary}）`}。内容が違うので、却下した${noun}の繰り返しには数えていません`;
    return { text, destination, ruleLabel, sent, rejected };
  }
  return null;
}

/** 走行の状況の行ごとの注記（incident・user_reject の試験の、判定まで済んだ行だけ）。scenarioId → 注記 */
export async function incidentNotesOfRun(
  deps: Pick<AppDeps, "db">,
  s: WsCtx,
  run: RehearsalRunRow,
  scenarios: readonly RehearsalScenarioRow[],
): Promise<Map<string, IncidentNoteView>> {
  const out = new Map<string, IncidentNoteView>();
  const done = scenarios.filter((x) => x.status === "done");
  if (done.length === 0) return out;
  const cases = new Map<string, RehearsalCaseRow | null>();
  for (const id of new Set(done.map((x) => x.case_id))) cases.set(id, await getRehearsalCase(deps.db, s, id));
  const targets = done.filter((x) => {
    const c = cases.get(x.case_id);
    return c != null && c.incident_kind === "user_reject" && (c.stopped_writes ?? []).some((w) => w.stoppedBy === "user_reject");
  });
  if (targets.length === 0) return out;
  const writes = await listRuleAllowedWritesOfScenarios(deps.db, s, targets.map((x) => x.id));
  // matched_rule の添字を、書き込みのときの実効ポリシー（走行に残したもの、なければタスクのスナップショット）のルールに直す（collectSlips と同じ）
  const snapshotPolicies = new Map<string, RehearsalRunRow["effective_policies"]>();
  for (const id of new Set(writes.map((w) => w.agentSnapshotId))) snapshotPolicies.set(id, (await getAgentSnapshotRow(deps.db, s, id))?.effective_policies ?? null);
  const ruleOf = (w: RuleAllowedWrite) => {
    const idx = ruleIndexOf(w.matchedRule);
    if (idx === null) return null;
    const policy = run.effective_policies?.[w.jobSlug]?.policy ?? snapshotPolicies.get(w.agentSnapshotId)?.[w.jobSlug]?.policy;
    return policy?.rules.items[idx] ?? null;
  };
  for (const x of targets) {
    const note = incidentNoteOf(
      cases.get(x.case_id)?.stopped_writes ?? [],
      writes.filter((w) => w.scenarioId === x.id),
      ruleOf,
    );
    if (note !== null) out.set(x.id, note);
  }
  return out;
}
