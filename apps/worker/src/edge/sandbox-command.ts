// 作業場のコマンド（run_command）をどの操作として判定するか（SG-07。packages/edge/src/sandbox-command.ts の WorkspaceDO 版）。LLM Proxy が判定の入力を作るときに使う。
// - 写し先は Kernel の純粋関数 operationOfCommand(command, 汚染) で決め、Subject.commandOperation に入れる。
//   汚染（外の内容を読んだか：taintedByOutsideContent）はここでだけ使い、decide には入れない（BR-39。kernel/decide.ts の冒頭）
// - run_shell は既定で deny。いまは MCP の書き込み以外を人の確認に回す経路（Intent・承認の行）がないので、approve でも実行されない
//   （runner は書き込みでない approve を実行しない）。どちらでも、LLM には「ここでは動かせない」と分かる文を返す（GovernanceEntry.note）
// - 4c では作業場の道具を TaskContext に渡さないが、モデルが run_command を返したときも Node 版と同じ入力で判定する（判定の記録をそろえる）

import { isAllowedCommandShape, operationOfCommand, taintOnWorkspaceSnapshot, taintedByOutsideContent, type JsonObject, type TaintState } from "@open-team/kernel";
import { getInitialSandboxSnapshotTaint } from "../db/repo/sandbox.ts";
import type { WsDb } from "../db/sqlite.ts";
import type { TaskRow } from "../db/types.ts";

export interface CommandJudgement {
  operation: "run_tests" | "run_shell";
  /** 形が許可リストにあるか（汚染は見ない） */
  shapeAllowed: boolean;
  /** 外の内容を読んだあとか（SG-07 の (a)） */
  outsideTainted: boolean;
}

/**
 * run_command の写し先に使う汚染：タスクの今の汚染に、作業場が受け取る控え（担当の最新の控え）の汚染を足したもの（SG-05 と合わせた監査の直し）。
 * 控えの汚染がタスクに付くのは作業場が控えを受け取ったとき（sandboxClaim）で、作業場は最初の道具の呼び出しの「実行」で起きる。
 * そのため、タスクの最初の run_command は控えの汚染が付く前に判定される。ここで先に足しておかないと、汚染されたタスクが
 * 残したファイル（注入で書かされた package.json・テスト）を、汚染なしの次のタスクの npm test が自動で動かしてしまう。
 * 作業場がもう控えを受け取っていても同じ控えなので二重にはならない（同じ鍵で1件）。自分が残した控えは足さない（taintOnWorkspaceSnapshot）。
 * 担当の別のタスクがあとから残した控えも足す（厳しい側）。判定に使うだけで、タスクの汚染は変えない（記録は sandboxClaim）
 */
export function commandTaintOf(db: WsDb, task: Pick<TaskRow, "id" | "agent_id">, taint: TaintState, now: Date): TaintState {
  const snap = getInitialSandboxSnapshotTaint(db, task.id);
  if (snap === null) return taint;
  const snapTaint: TaintState = { tainted: snap.tainted, sources: Array.isArray(snap.taint_sources) ? snap.taint_sources : [] };
  return taintOnWorkspaceSnapshot(taint, { snapshotId: snap.id, fromTaskId: snap.task_id, taint: snapTaint }, task.id, now.toISOString());
}

/** run_command の引数と、判定の時点の汚染（commandTaintOf）から写し先を決める */
export function judgeCommand(args: JsonObject, taint: TaintState): CommandJudgement {
  const command = args.command;
  const outsideTainted = taintedByOutsideContent(taint);
  return { operation: operationOfCommand(command, outsideTainted), shapeAllowed: isAllowedCommandShape(command), outsideTainted };
}

/** 形が許可リストにないとき（汚染の有無にかかわらず） */
export const RUN_SHELL_SHAPE_TEXT =
  "このコマンドはここでは動かせません。作業場で動かせるのは決まった形のテスト・実行のコマンドだけです：" +
  "npm test・npm ci・npm install・npm run <名前>・pytest・python3 -m pytest・python3 -m unittest・node --test・" +
  "node <ファイル>.js・python3 <ファイル>.py <引数>。" +
  "パイプ（|）・リダイレクト（>）・;・&&・$()・引用符・# などのシェルの書き方、curl・wget などの道具、作業場の外を指すパス（..・/ で始まるもの）は使えません。" +
  "1回に1つのコマンドを、作業場の根からの相対パスで動かしてください。";

/** 外の内容を読んだあと（形が許可リストにあっても） */
export const RUN_SHELL_TAINTED_TEXT =
  "このコマンドはここでは動かせません。このタスクは外から読んだ内容（Web・コネクタ・ほかの担当から受け取った内容など）のあとなので、" +
  "作業場のコマンドは形にかかわらず動かせません。コマンドを動かさずにできる範囲で進め、動かして確かめていないことを報告に書いてください。";

/** run_shell として判定され、実行しない呼び出しに添える文。run_tests なら undefined。汚染のあとは形を直しても動かないので汚染の文を優先する */
export function commandDeniedNote(j: CommandJudgement): string | undefined {
  if (j.operation !== "run_shell") return undefined;
  return j.outsideTainted ? RUN_SHELL_TAINTED_TEXT : RUN_SHELL_SHAPE_TEXT;
}
