// 形の1行（固定の文テンプレート。LLM に書かせない。entrance.md §生成中）
// 契約の shapeLine（サーバーが作る同じ文）があればそれを使い、ないときだけここで作る
import type { AskShape } from "../api";

export interface ShapeMember {
  agentName: string;
  position: number | null;
  isAggregator: boolean;
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
      const ordered = [...members].sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));
      const last = ordered[ordered.length - 1];
      if (!last) return null;
      return `${ordered.map((m) => m.agentName).join(" → ")} の順に進めて、${last.agentName}が答えます`;
    }
  }
}
