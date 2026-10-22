// 編成の進め方の決定（FR-062。apps/app/src/asks/plan.ts の WorkspaceDO 版。依頼のページは「やり直す」の段を見つけるのに使う）：いまのタスクの状態から「次に始める担当」「実行の状態」「回答を出してよいか」を決める純粋関数。
// DB・時刻・乱数に触らない（時刻は引数）。呼び出し側（run.ts）はこの結果どおりにタスクを作り、状態を書き換える。
// 形ごとの動かし方（agents.md FR-062）：
//   single    担当を始める
//   parallel  全員を同時に始める。受け渡しはしない。一部が失敗しても、ほかはそのまま続ける
//   aggregate 担当を同時に始め、全員が終わるか待ち時間（A-100）を過ぎたら、まとめ役を始める。終わった分だけでまとめる。全員が失敗したらまとめ役は動かさない
//   chain     依存する担当（dependsOn）がすべて済み（succeeded / completed）になった担当から始める。依存のない担当・依存が同時に済んだ担当は同時に始める。
//             止まった担当に依存する担当は始めず、ほかの担当が動き終わったら waiting_input（やり直す／ここまでで終える）
// 「受け渡し」は input_task_ids（元のタスク）と汚染の引き継ぎ（run.ts が taintFromInputs で）。この関数は誰の結果を渡すかまでを決める

import type { TaskStatus } from "../../db/types.ts";

export type Shape = "single" | "parallel" | "aggregate" | "chain";
export type RunStatus = "running" | "waiting_input" | "done" | "failed";

/** タスクの状態の分類 */
export type TaskPhase = "none" | "active" | "awaiting" | "ok" | "stopped";

/** まとめ役が待つ時間（A-100：最初の担当が始まってから30分） */
export const AGGREGATOR_WAIT_MS = 30 * 60_000;

export function phaseOf(status: TaskStatus | null): TaskPhase {
  if (status === null) return "none";
  switch (status) {
    case "queued":
    case "provisioning":
    case "running":
    case "executing":
      return "active";
    case "awaiting_approval":
      return "awaiting";
    case "succeeded":
    case "completed":
      return "ok";
    default:
      return "stopped"; // rejected・failed・cancelled・halted
  }
}

export interface PlanTask {
  id: string;
  status: TaskStatus;
  /** 報告を出していれば true（本文の有無） */
  hasReport: boolean;
}

export interface PlanMember {
  memberId: string;
  position: number | null;
  isAggregator: boolean;
  /** この実行での最新のタスク（まだなければ null）。やり直しは新しいタスクが最新になる */
  task: PlanTask | null;
  /** 順番で結果を受け取る担当の position。省略は1つ前の段（従来の1段ずつ） */
  dependsOn?: readonly number[];
}

export interface PlanInput {
  shape: Shape;
  members: readonly PlanMember[];
  now: Date;
  /** 最初の担当が始まった時刻（A-100 の起点。始まっていなければ null） */
  firstStartedAt: Date | null;
  aggregatorWaitMs?: number;
}

export interface PlanStart {
  memberId: string;
  /** 受け渡す元のタスク（BR-71）。順番は依存する段、まとめ役は全担当、ほかは空 */
  inputTaskIds: string[];
}

export interface PlanOutput {
  /** 次に始める担当（タスクを新しく作る） */
  start: PlanStart[];
  status: RunStatus;
  /** 順番で止まった担当（status が waiting_input のとき） */
  stoppedMemberId: string | null;
  /** 回答を出してよいか（出したあとの書き換えは run.ts が行う） */
  answerReady: boolean;
}

const bySort = (a: PlanMember, b: PlanMember): number => (a.position ?? 99) - (b.position ?? 99);

/** 報告を出した（終わった・確認待ち・動いている最中でも報告済み）か、終わった・止まった担当 */
function isDoneEnough(m: PlanMember): boolean {
  const t = m.task;
  if (t === null) return false;
  const p = phaseOf(t.status);
  return p === "ok" || p === "stopped" || p === "awaiting" || t.hasReport;
}

/** 実行の最終状態：1つでも済みがあれば done、なければ failed */
function finalStatus(workers: readonly PlanMember[]): RunStatus {
  return workers.some((m) => phaseOf(m.task?.status ?? null) === "ok") ? "done" : "failed";
}

export function evaluateRun(input: PlanInput): PlanOutput {
  const members = [...input.members].sort(bySort);
  const workers = members.filter((m) => !m.isAggregator);
  const aggregator = members.find((m) => m.isAggregator) ?? null;
  const phases = (ms: readonly PlanMember[]): TaskPhase[] => ms.map((m) => phaseOf(m.task?.status ?? null));
  const waitMs = input.aggregatorWaitMs ?? AGGREGATOR_WAIT_MS;
  const timedOut = input.firstStartedAt !== null && input.now.getTime() - input.firstStartedAt.getTime() >= waitMs;

  switch (input.shape) {
    case "single":
    case "parallel": {
      const start = workers.filter((m) => m.task === null).map((m): PlanStart => ({ memberId: m.memberId, inputTaskIds: [] }));
      const ps = phases(workers);
      const open = start.length > 0 || ps.some((p) => p === "active" || p === "awaiting");
      const answerReady =
        input.shape === "single"
          ? (workers[0]?.task?.hasReport ?? false) || !open
          : workers.every(isDoneEnough) || timedOut || !open;
      return { start, status: open ? "running" : finalStatus(workers), stoppedMemberId: null, answerReady };
    }

    case "aggregate": {
      const start: PlanStart[] = workers.filter((m) => m.task === null).map((m) => ({ memberId: m.memberId, inputTaskIds: [] }));
      const ps = phases(workers);
      const workersOpen = start.length > 0 || ps.some((p) => p === "active" || p === "awaiting");
      if (aggregator === null) {
        // 検査（validateFormation）で防ぐ形。まとめ役がなければ並列と同じに扱う
        return { start, status: workersOpen ? "running" : finalStatus(workers), stoppedMemberId: null, answerReady: !workersOpen };
      }
      const aggPhase = phaseOf(aggregator.task?.status ?? null);
      const reported = workers.filter((m) => m.task?.hasReport === true);
      if (aggregator.task === null) {
        const ready = start.length === 0 && (workers.every(isDoneEnough) || timedOut);
        if (ready && reported.length > 0) {
          // 受け渡すのは報告を出したタスクだけ。報告のない（動作中・失敗で本文なし）タスクは、まとめ役が動くまでに報告が変わりうるので入れない
          const ids = reported.flatMap((m) => (m.task === null ? [] : [m.task.id]));
          return { start: [{ memberId: aggregator.memberId, inputTaskIds: ids }], status: "running", stoppedMemberId: null, answerReady: false };
        }
        if (ready && reported.length === 0) {
          // 全員が失敗（報告なし）：まとめ役は動かさず、失敗として終える（回答は「〇〇で止まりました」）
          return { start: [], status: "failed", stoppedMemberId: null, answerReady: true };
        }
        return { start, status: "running", stoppedMemberId: null, answerReady: false };
      }
      const aggOpen = aggPhase === "active" || aggPhase === "awaiting";
      const open = workersOpen || aggOpen;
      return {
        start: [],
        status: open ? "running" : aggPhase === "ok" ? "done" : "failed",
        stoppedMemberId: null,
        answerReady: aggregator.task.hasReport || !open,
      };
    }

    case "chain": {
      const stages = workers;
      const byPosition = new Map(stages.map((m) => [m.position, m]));
      const depsOf = (m: PlanMember, i: number): PlanMember[] => {
        const positions = m.dependsOn ?? (i === 0 ? [] : [stages[i - 1]!.position]);
        return positions.flatMap((p) => byPosition.get(p) ?? []);
      };
      const start: PlanStart[] = [];
      let stopped: PlanMember | null = null;
      let open = false;
      stages.forEach((s, i) => {
        if (s.task === null) {
          const deps = depsOf(s, i);
          if (deps.every((d) => phaseOf(d.task?.status ?? null) === "ok")) {
            start.push({ memberId: s.memberId, inputTaskIds: deps.flatMap((d) => (d.task === null ? [] : [d.task.id])) });
          }
          return;
        }
        const p = phaseOf(s.task.status);
        if (p === "active" || p === "awaiting") open = true;
        if (p === "stopped" && stopped === null) stopped = s;
      });
      const last = stages[stages.length - 1];
      const lastPhase = phaseOf(last?.task?.status ?? null);
      if (start.length > 0 || open) {
        const answerReady = last?.task != null && (lastPhase === "active" || lastPhase === "awaiting") && last.task.hasReport;
        return { start, status: "running", stoppedMemberId: null, answerReady };
      }
      // 動いている担当がなく、止まった担当がいる：その先は始められない
      if (stopped !== null) return { start: [], status: "waiting_input", stoppedMemberId: (stopped as PlanMember).memberId, answerReady: false };
      // すべての段が済み
      return { start: [], status: "done", stoppedMemberId: null, answerReady: true };
    }
  }
}
