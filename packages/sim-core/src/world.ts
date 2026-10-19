// 世界の枠組み（共通。15:275「世界の登録・状態の分け方・障害の注入は最初から共通にし、あとで世界を足すだけにする」）
// sim-world-rehearsal.md §4.1.1。状態は jsonb 1つで持つ前提（M-40）で、ここは純粋な型と関数だけ。保存は apps/sim-world

import type { ArgPath, ArgRoleMap, Hex64, IsoDateTime, JsonObject, ToolClassification, ToolScope } from "@open-team/kernel";
import type { FaultId, WorldId } from "./common.ts";
import type { DamageBreakdown } from "./results.ts";
import type { Scenario, ScenarioContext } from "./scenario.ts";

/** sim-world の manifest のツール（mcp-taint.md §2.10 ＋ G-13 の表示用の項目） */
export interface SimToolManifest {
  name: string;
  classification: ToolClassification;
  /** 書き込みツールは全引数（配列の要素のフィールドも全部）に役割を付ける（BR-56。書かなければ destination 扱い） */
  argRoles: ArgRoleMap;
  scope: ToolScope;
  verify: "none";
  /** 操作の名前（G-13。「発注」「メール」「振込先の登録」。UI §9-24） */
  actionNoun: string;
  /** 引数の単位（G-13。理由の文の「20個」「800円」） */
  units: Readonly<Record<ArgPath, string>>;
  /** 読めない宛先 ID の表示名を引く read ツール（G-13、D-31、MT D-38）。readTool を { [arg]: 値 } で呼び、resultPath を読む */
  destinationLabel?: { arg: ArgPath; readTool: string; resultPath: string };
}

/** サービスごとに1コネクタ（MT D-01）。URL は SIM_WORLD_URL + path（/mcp/<world>/<service>） */
export interface SimConnectorManifest {
  world: WorldId;
  slug: string;
  displayName: string;
  path: string;
  tools: readonly SimToolManifest[];
}

/** 追記だけの記録（オラクル・損害・タイムラインの入力。SW §3.5）。seq は走行の中の通し番号 */
export interface SimEvent {
  seq: number;
  /** 仮想時刻 */
  at: IsoDateTime;
  kind: "tool_call" | "clock" | "delivery" | "payment" | "sales" | "fault";
  /** '<コネクタ>.<ツール>' */
  tool?: string;
  args?: unknown;
  result?: unknown;
  outcome?: "ok" | "tool_error" | "http_429" | "http_503" | "timeout_after_commit" | "not_committed";
  /** 書き込みが状態に反映されたか（書き込みツールだけ。F-01 はタイムアウトでも true） */
  committed?: boolean;
  intentId?: string | null;
  taskId?: string | null;
  caller: "sa-gateway" | "sa-app" | "clock";
}

/** MCP の tools/call（コネクタ＝URL のサービス、ツール＝接頭辞なしの名前） */
export interface ToolCall {
  connector: string;
  tool: string;
  args: unknown;
}

/** 呼び出しの文脈。値は gateway がタスク・Intent の行から引き直したもの（15:486） */
export interface CallCtx {
  caller: "sa-gateway";
  taskId: string | null;
  intentId: string | null;
  shadow: boolean;
}

/**
 * ツールの呼び出しの結果。event はその呼び出しの tool_call の事象、events は sim.events にこの順で足すもの
 * （F-08 で説明が替わった 'fault' の事象が前に入ることがある。最後は event）
 */
export type ToolOutcome<S> =
  /** 正常 */
  | { kind: "ok"; state: S; result: unknown; event: SimEvent; events: SimEvent[] }
  /** MCP の isError: true（引数の誤り・仕入れ先なし・429） */
  | { kind: "tool_error"; state: S; message: string; event: SimEvent; events: SimEvent[] }
  /** HTTP のエラー（503 は F-07、504 は F-01 で反映済み） */
  | { kind: "http_error"; state: S; status: 429 | 503 | 504; event: SimEvent; events: SimEvent[] };

/**
 * Web の取得・検索（リハーサルの web_fetch・web_search の口。リハーサル専用で、本番の edge は使わない）。
 * 世界ごとに中身が違うので、世界が持つ場合だけ handleWeb を実装する
 */
export type WebRequest = { kind: "fetch"; url: string } | { kind: "search"; query: string; maxResults?: number };

/** Web の応答。state は新しい状態、events はその応答で足した事象（障害のページを読んだ・見せた） */
export interface WebOutcome<S> {
  state: S;
  /** 応答の中身（世界ごとの形。fetch は status・title・body、search は results） */
  result: unknown;
  events: SimEvent[];
}

/** tools/list の1件（説明は F-08 で替わったあとのもの） */
export interface SimToolListing {
  connector: string;
  name: string;
  description: string;
  inputSchema: JsonObject;
  /** 注釈（読むだけのツールの readOnlyHint。模擬の Google カレンダーだけ返す：16 §6.1 の一致の試験） */
  annotations?: { readOnlyHint: true };
}

export interface DamageInput<S> {
  initial: S;
  final: S;
  events: readonly SimEvent[];
  scenario: Scenario;
}

/** 世界の登録の最小の形（manifest と注入できる障害）。Should の世界はこれだけの枠 */
export interface WorldFrame {
  id: WorldId;
  connectors: readonly SimConnectorManifest[];
  supportedFaults: readonly FaultId[];
  implemented: boolean;
}

/**
 * 動く世界。advance は乱数の状態を状態の中（rng）から使うので PRNG を引数に取らない（§4.1.1 の案から変えた：
 * jsonb に保存して続きから引けるようにするため）。O-05（業務の条件）は packages/oracles に置く（循環を作らない）
 */
export interface WorldDefinition<S> extends WorldFrame {
  implemented: true;
  /** 今の基準の状態の版（15:341 の seed_version） */
  seedVersion: string;
  createInitialState(seed: number, opts: { seedVersion: string; startDate?: string }): S;
  /**
   * 走行の初期状態を作る：走行ごとの数え方（日の番号・呼び出しの回数・事象の番号など）を始めに戻してから、状況の障害を置く。
   * シードからの状態にも、デモ店舗のスナップショット（FR-066）にも同じようにかける
   */
  applyScenario(state: S, scenario: Scenario): S;
  handleTool(state: S, call: ToolCall, ctx: CallCtx): ToolOutcome<S>;
  /** Web の取得・検索（F-14 など。Web を持たない世界は未定義） */
  handleWeb?(state: S, req: WebRequest): WebOutcome<S>;
  listTools(state: S, connector?: string): SimToolListing[];
  advance(state: S, to: IsoDateTime): { state: S; events: SimEvent[] };
  computeDamage(input: DamageInput<S>): DamageBreakdown;
  scanCanaries(writes: readonly SimEvent[], state: S): DamageBreakdown["secretLeaks"];
  /** 正規形 JSON（RFC 8785 相当）の SHA-256（SW §4.4.9、sim.snapshots.state_hash） */
  stateHash(state: S): Hex64;
  /** 状況の文脈の検証に使う中身（§3.3 の2段目） */
  scenarioContext(): ScenarioContext;
}

/** '<コネクタ>.<ツール>' から manifest を引く */
export function findToolManifest(
  connectors: readonly SimConnectorManifest[],
  tool: string,
): { connector: SimConnectorManifest; tool: SimToolManifest } | null {
  const dot = tool.indexOf(".");
  if (dot <= 0) return null;
  const slug = tool.slice(0, dot);
  const name = tool.slice(dot + 1);
  const connector = connectors.find((c) => c.slug === slug);
  const t = connector?.tools.find((x) => x.name === name);
  return connector && t ? { connector, tool: t } : null;
}

/** '<コネクタ>.<ツール>' の操作名（'mcp.supplier.place_order'。catalogs.md:63） */
export function simActionOf(tool: string): string {
  return `mcp.${tool}`;
}

/** manifest のツールを '<コネクタ>.<ツール>' で並べる */
export function toolNamesOf(connectors: readonly SimConnectorManifest[]): string[] {
  return connectors.flatMap((c) => c.tools.map((t) => `${c.slug}.${t.name}`));
}
