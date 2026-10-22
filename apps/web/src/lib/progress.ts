// 担当の段の進み具合（やったことの印・経過の1行）。文はここで決め、画面はそのまま出す
import type { StageActivity, StageView } from "../api";

/** やったことの印（色だけに頼らず、記号と短い文も添える） */
export function activityMark(outcome: StageActivity["outcome"]): { icon: string; text: string | null } {
  switch (outcome) {
    case "done":
      return { icon: "✓", text: null };
    case "approval":
      return { icon: "?", text: "あなたの確認へ" };
    case "denied":
      return { icon: "✕", text: "統制が止めた" };
    case "halted":
      return { icon: "■", text: "安全装置で止めた" };
  }
}

/** 経過の1行。動いている間は「12秒」、終わったら「38秒で済み」など。時刻が分からなければ null */
export function stageClock(s: Pick<StageView, "state" | "startedAt" | "finishedAt">, runningSec: number | null): string | null {
  if (s.state === "running") return runningSec === null ? null : durationText(runningSec);
  if (!s.startedAt || !s.finishedAt) return null;
  const sec = (new Date(s.finishedAt).getTime() - new Date(s.startedAt).getTime()) / 1000;
  if (!Number.isFinite(sec) || sec < 0) return null;
  const tail = s.state === "done" ? "で済み" : s.state === "awaiting_approval" ? "で確認待ちに" : "";
  return `${durationText(sec)}${tail}`;
}

/** 秒を「38秒」「2分」「3分5秒」の文にする（2分未満は秒で出す） */
export function durationText(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return s < 120 ? `${s}秒` : `${Math.floor(s / 60)}分${s % 60 === 0 ? "" : `${s % 60}秒`}`;
}
