import type { AskDetail, StageView } from "../api";

/** queued / provisioning は稼働数に含めない。旧APIでは並列を推測しない。 */
export function isWorking(s: StageView): boolean {
  return s.state === "running" && (s.taskStatus === "running" || s.taskStatus === "executing");
}
export function teamCounts(stages: readonly StageView[]) {
  return { working: stages.filter(isWorking).length, done: stages.filter(s => s.state === "done").length,
    waiting: stages.filter(s => s.state === "waiting" || s.state === "awaiting_approval" || (s.state === "running" && !isWorking(s))).length,
    stopped: stages.filter(s => s.state === "failed" || s.state === "stopped").length };
}
export function stageLabel(s: StageView): string {
  if (isWorking(s)) return "作業中";
  if (s.state === "running") return s.taskStatus === "queued" ? "順番待ち" : s.taskStatus === "provisioning" ? "準備中" : "状態を確認中";
  return { waiting: "待機", awaiting_approval: "確認待ち", done: "完了", failed: "失敗", stopped: "停止" }[s.state];
}
export function dependencies(detail: Pick<AskDetail, "formation">, s: StageView): string[] {
  const members = detail.formation?.members ?? [];
  const positions = members.find(m => m.memberId === s.memberId)?.dependsOn ?? [];
  return positions.map(p => members.find(m => m.position === p)?.agentName ?? `エージェント ${p}`);
}
