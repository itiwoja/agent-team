// パックの担当の型（テンプレート）の言い方と、作業場が要る担当の判定。
// 棚（screens/Packs.tsx）・作業場（screens/PackWorkspace.tsx）・入れたときの演出（components/PackInstallCeremony.tsx）が同じものを使う
// （画面どうしで import し合うと循環になるので、ここに置く）

/** 担当の型（テンプレート）の言い方（エージェントの画面の仕事の札と同じ語） */
export const TEMPLATE_LABEL: Readonly<Record<string, string>> = {
  researcher: "調べる",
  briefer: "まとめる",
  watcher: "見張る",
  assistant: "手伝う",
  "dev-coder": "作る",
  reviewer: "見直す",
};

/** 作業場が要る担当（書いて動かす） */
export function needsWorkspace(template: string): boolean {
  return template === "dev-coder" || template === "reviewer";
}
