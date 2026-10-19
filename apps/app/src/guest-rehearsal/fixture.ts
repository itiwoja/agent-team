// ゲストのリハーサルの結果の事前計算（fixture.json）の型と版。作り方は build.test.ts、入れ方は seed.ts

import { computeMcpIntentHash, hashCanonical, type JsonObject } from "@open-team/kernel";

/** fixture の版（seed_version とは別。fixture を作り直したら上げる） */
export const GUEST_REHEARSAL_FIXTURE_VERSION = "guest-rehearsal-v1";

/** 走行のシード（uint32） */
export const RUN_SEED = 20261003;

/** テーブルの行（to_jsonb の形）。ID は連番の仮 ID、時刻は "@t"（入れるときに決める）、workspace_id・生成列は持たない */
export type FixtureRow = Record<string, unknown>;

interface StageRefs {
  agent: string;
  job: string;
  snapshot: string;
  member: string;
}

export interface GuestRehearsalFixture {
  version: string;
  /** 入れ先のワークスペースの本物に置き換える ID（仮 ID → 本物） */
  refs: {
    workspace: string;
    user: string;
    ask: string;
    inbox: StageRefs;
    buyer: StageRefs;
    /** コネクタの slug → 仮 ID */
    connectors: Record<string, string>;
    /** ツール名 → 作ったときの tool_hash（入れ先の同じツールの値に置き換える） */
    toolHashes: Record<string, string>;
  };
  run: FixtureRow;
  cases: FixtureRow[];
  scenarios: FixtureRow[];
  /** すり抜けた状況（verdict = fail）の ID */
  slippedScenarioIds: string[];
  /** すり抜けた状況の本番の経路（governed）のタスク。受信箱係 → 仕入れ係の順 */
  tasks: FixtureRow[];
  intents: FixtureRow[];
  decisions: FixtureRow[];
}

/** Intent の指紋を、行の中身（コネクタの ID・ツールの指紋・引数・実効ポリシーの指紋）から作り直す。ID を置き換えたあとも行の中で食い違わないように */
export function intentHashOfRow(row: FixtureRow): string {
  const payload = row.payload as { tool: string; arguments: JsonObject };
  return computeMcpIntentHash({
    connectorId: row.connector_id as string,
    tool: payload.tool,
    arguments: payload.arguments,
    toolHash: row.tool_hash as never,
    effectivePolicyHash: row.policy_hash as never,
  });
}

/** 判定の記録の入力の指紋を、行の中身から作り直す（入力は subject・汚染・フラグ・数え物） */
export function decisionInputsHashOfRow(row: FixtureRow): string {
  return hashCanonical({ subject: row.subject, taint: row.taint, flags: row.flags, counters: row.counters } as unknown as JsonObject);
}
