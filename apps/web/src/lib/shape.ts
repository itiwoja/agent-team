// 形の1行（固定の文テンプレート。LLM に書かせない。entrance.md §生成中）
// 契約の shapeLine（サーバーが作る同じ文）があればそれを使い、ないときだけここで作る
import type { AskShape } from "../api";

export interface ShapeMember {
  agentName: string;
  position: number | null;
  isAggregator: boolean;
  /** 順番で結果を受け取る段の position（ないときは1つ前の段） */
  dependsOn?: readonly number[];
}

/**
 * 順番の段の番号（1 始まり）：position → 段。同時に動く担当は同じ段（kernel の chainStages と同じ規則）。
 * 段の番号は「依存する段のうち一番深いもの + 1」。dependsOn がない担当は1つ前の段に依存するものとして扱う
 */
export function chainLevels(members: ReadonlyArray<{ position: number | null; dependsOn?: readonly number[] }>): Map<number, number> {
  const sorted = members.flatMap((m) => (m.position === null ? [] : [{ position: m.position, dependsOn: m.dependsOn }])).sort((a, b) => a.position - b.position);
  const level = new Map<number, number>();
  sorted.forEach((m, i) => {
    const deps = m.dependsOn ?? (i === 0 ? [] : [sorted[i - 1]!.position]);
    level.set(m.position, 1 + Math.max(0, ...deps.map((d) => level.get(d) ?? 0)));
  });
  return level;
}

export function shapeLineOf(shape: AskShape | null, members: readonly ShapeMember[]): string | null {
  if (shape === null || shape === "single") return null;
  const workers = members.filter((m) => !m.isAggregator);
  const n = workers.length;
  switch (shape) {
    case "parallel":
      return `${n}人がそれぞれ動いて、答えを1つにして届けます`;
    case "aggregate":
      return `${n}人が調べて、まとめ役が1つにして届けます`;
    case "chain": {
      const ordered = [...workers].sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));
      const last = ordered[ordered.length - 1];
      if (!last) return null;
      const level = chainLevels(ordered);
      const groups: string[][] = [];
      ordered.forEach((m, i) => (groups[(level.get(m.position ?? -1) ?? i + 1) - 1] ??= []).push(m.agentName));
      const stages = groups.filter((g) => g !== undefined);
      const flow = stages.map((g) => g.join("・")).join(" → ");
      const together = stages.filter((g) => g.length > 1).map((g) => g.join("と"));
      return together.length === 0
        ? `${flow} の順に進めて、${last.agentName}が答えます`
        : `${flow} の順に進めて（${together.join("、")}は同時に動きます）、${last.agentName}が答えます`;
    }
  }
}
