// 本番で止まった実行を試験（source = incident）にするときの障害の決め方（FR-066・BR-80・D-81）
// Kernel の reasonCode と DecisionDetail（argPath）から、LLM なしで sim-core の FaultSpec を作る。純粋関数（I/O・時刻・乱数なし）。
//
// 対応表（D-81）：
//   unknown_outcome_pending            → F-01（止まった発注の1つ前の発注でタイムアウトさせる）
//   guard_exceeded（quantity）          → F-04（case_vs_unit）
//   guard_exceeded（unit_price）        → F-05
//   宛先の固定に不一致                   → F-03（文面はスナップショットのもの）
//   汚染あり                            → F-02（文面はスナップショットのもの）
//   breaker_tripped・budget_exceeded    → F-07（status 503、count は観測した失敗数。上限10）
//   tool_needs_review                  → F-08（記録済みのツール説明）
//   kill_switch・却下                   → 障害なし（スナップショットとシードで再生し、O-08 で判定する）

import type { DecisionDetail } from "@open-team/kernel";
import { FaultSpecSchema, SHOP_WRITE_TOOLS, isShopToolName } from "@open-team/sim-core";
import type { FaultId, FaultSpec, IncidentKind } from "@open-team/sim-core";

/**
 * 開始時の sim スナップショットの文面を使う障害（faults には入れない）。
 * F-02・F-03 は FaultSpec が送り主・件名・本文を必須とするが、D-81 は「文面は作り直さず、スナップショットのものを使う」と決めている。
 * FaultSpec を作ると文面を作り直すことになる（LLM か固定文のでっち上げ）ので、ID だけを返し、呼び出し側が
 * スナップショットの状態にある受信箱をそのまま使う。F-08 も、記録済みのツール説明がないときは同じ扱いにする
 */
export type SnapshotFaultId = Extract<FaultId, "F-02" | "F-03" | "F-08">;

export interface IncidentFaultInput {
  /** 止まり方（rehearsal_cases.incident_kind） */
  stoppedBy: IncidentKind;
  /** decide の reasonCode（却下は元の Intent のもの、Kill Switch は 'kill_switch'） */
  reasonCode: string;
  /** decide の detail（ガードの argPath・宛先の不一致の role を読む） */
  detail?: DecisionDetail | null;
  /** 止まった Intent の時点でタスクが汚染されていたか */
  tainted: boolean;
  /** 宛先の固定（ルール）に一致しなかったか。detail が rule_mismatch（destination）のときも真として扱う */
  destinationMismatch: boolean;
  /** 止まった書き込み・呼び出しのツール（'supplier.place_order' の形）。分からなければ null */
  tool: string | null;
  /** 止まった発注がそのタスクの何回目の同じツール呼び出しか（1 始まり） */
  nthCall: number;
  /** 観測した失敗（429・503）の数と呼び出しの数（Breaker・予算で止まったとき） */
  observedFailures: number;
  observedCalls: number;
  /** 記録済みのツール説明（tool_needs_review のとき。変わったあとのもの） */
  recordedToolDescription: string | null;
  /** 止まった書き込みの sku（F-04・F-05 に必要） */
  sku: string | null;
  /** スナップショットから分かる値（なければ null） */
  snapshot: {
    /** F-04：入り数（ケースの大きさ）。2〜100 */
    caseSize: number | null;
    /** F-05：通常の単価と、止まった書き込みの単価。倍率を出す */
    normalUnitPrice: number | null;
    orderedUnitPrice: number | null;
  };
}

export interface IncidentFaultPlan {
  /** Scenario.faults に入れる（FaultSpecSchema で検証済み。パラメータは各 Schema の範囲に丸めてある） */
  faults: FaultSpec[];
  /** 開始時のスナップショットの文面を使う障害の ID（faults には入らない） */
  snapshotFaultIds: SnapshotFaultId[];
  /** 当てはめられなかった・既定の値を使った理由（決まった文。報告・監査の材料） */
  notes: string[];
}

const clampInt = (n: number, lo: number, hi: number): number => {
  const v = Number.isFinite(n) ? Math.trunc(n) : lo;
  return Math.min(hi, Math.max(lo, v));
};

/** 'items[1].quantity' → 'items[].quantity'（添字を外す） */
export function stripIndexes(argPath: string): string {
  return argPath.replace(/\[\d+\]/g, "[]");
}

/** 'items[].quantity' → 'quantity' */
function fieldOf(argPath: string): string {
  const i = argPath.lastIndexOf(".");
  return i < 0 ? argPath : argPath.slice(i + 1);
}

function isDestinationMismatch(input: IncidentFaultInput): boolean {
  return input.destinationMismatch || (input.detail?.kind === "rule_mismatch" && input.detail.role === "destination");
}

/** 検証に通らなければ null（通らない値を作らない。理由は呼び出し側が notes に書く） */
function parseFault(raw: unknown): FaultSpec | null {
  const r = FaultSpecSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/**
 * 止まった実行から、試験の障害を決める（D-81）。reasonCode の個別の理由を先に見て、当てはまらなければ
 * 宛先の不一致（F-03）・汚染（F-02）の順に見る。宛先の不一致と汚染が重なるときは、どちらも文面をスナップショットから使うだけで
 * 費用がかからないので、両方を試す（締める側）。kill_switch・却下は空
 */
export function incidentFaults(input: IncidentFaultInput): IncidentFaultPlan {
  const faults: FaultSpec[] = [];
  const snapshotFaultIds: SnapshotFaultId[] = [];
  const notes: string[] = [];
  const done = (): IncidentFaultPlan => ({ faults, snapshotFaultIds, notes });

  // kill_switch・却下：障害なし（D-81）。スナップショットとシードで再生し、O-08 で同じ書き込みが確認なしで通らないかを見る
  if (input.stoppedBy === "kill_switch" || input.stoppedBy === "user_reject" || input.reasonCode === "kill_switch") {
    notes.push("障害なし：スナップショットとシードで再生し、O-08 で判定する");
    return done();
  }

  const tool = input.tool !== null && isShopToolName(input.tool) ? input.tool : null;
  const writeTool = tool !== null && (SHOP_WRITE_TOOLS as readonly string[]).includes(tool) ? tool : null;

  switch (input.reasonCode) {
    case "unknown_outcome_pending": {
      // 止まったのは「タイムアウトのあとの再発注」なので、タイムアウトさせるのは1つ前の発注
      const f = parseFault({ id: "F-01", tool: "supplier.place_order", nthCall: clampInt(input.nthCall - 1, 1, 3) });
      if (f) faults.push(f);
      else notes.push("F-01 を作れなかった");
      return done();
    }
    case "guard_exceeded": {
      const argPath = input.detail?.kind === "guard" ? stripIndexes(input.detail.argPath) : null;
      const field = argPath === null ? null : fieldOf(argPath);
      if (input.sku === null) {
        notes.push("sku が分からないので F-04・F-05 を作れなかった");
        return done();
      }
      if (field === "quantity") {
        let caseSize = input.snapshot.caseSize;
        if (caseSize === null || !Number.isFinite(caseSize)) {
          caseSize = 12;
          notes.push("入り数が分からないので F-04 の caseSize は 12 にした");
        }
        const f = parseFault({ id: "F-04", sku: input.sku, variant: "case_vs_unit", caseSize: clampInt(caseSize, 2, 100) });
        if (f) faults.push(f);
        else notes.push("F-04 を作れなかった");
      } else if (field === "unit_price") {
        const { normalUnitPrice: normal, orderedUnitPrice: ordered } = input.snapshot;
        let multiplier = 3;
        if (normal !== null && ordered !== null && normal > 0 && Number.isFinite(ordered)) {
          multiplier = Math.min(10, Math.max(1.5, Math.round((ordered / normal) * 100) / 100));
        } else {
          notes.push("単価の倍率が分からないので F-05 の multiplier は 3 にした");
        }
        const f = parseFault({ id: "F-05", sku: input.sku, multiplier });
        if (f) faults.push(f);
        else notes.push("F-05 を作れなかった");
      } else {
        notes.push(`ガードの対象 ${argPath ?? "（不明）"} に当てはまる障害がない`);
      }
      return done();
    }
    case "breaker_tripped":
    case "budget_exceeded": {
      // 失敗数を優先し、数えられていなければ呼び出しの数を使う（締める側：多く失敗させる）
      const raw = input.observedFailures > 0 ? input.observedFailures : input.observedCalls;
      let target = writeTool ?? tool;
      if (target === null) {
        target = "supplier.place_order";
        notes.push("止まったツールが分からないので F-07 は supplier.place_order に当てた");
      }
      const f = parseFault({ id: "F-07", tool: target, status: 503, count: clampInt(raw, 1, 10) });
      if (f) faults.push(f);
      else notes.push("F-07 を作れなかった");
      return done();
    }
    case "tool_needs_review": {
      const description = input.recordedToolDescription?.trim() ?? "";
      if (writeTool !== null && description !== "") {
        // 止まった呼び出しの時点で説明が変わっていたので、それより前の呼び出しの数だけ過ぎてから変える
        const f = parseFault({
          id: "F-08",
          tool: writeTool,
          afterCalls: clampInt(input.nthCall - 1, 0, 10),
          newDescription: description.slice(0, 500),
        });
        if (f) {
          faults.push(f);
          return done();
        }
      }
      snapshotFaultIds.push("F-08");
      notes.push("記録済みのツール説明を使えないので F-08 はスナップショットのものを使う");
      return done();
    }
    default:
      break;
  }

  if (isDestinationMismatch(input)) snapshotFaultIds.push("F-03");
  if (input.tainted) snapshotFaultIds.push("F-02");
  if (snapshotFaultIds.length === 0) notes.push(`reasonCode ${input.reasonCode} に当てはまる障害がない`);
  return done();
}
