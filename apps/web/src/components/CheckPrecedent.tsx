// 送る前の確認の1行の前例（同じ仕事・同じ action のリハーサル）。文は apps/app/src/check/precedent.ts が決める。ここは表示だけ
// 控えめな注記（本文より小さく・muted の色）。前例がなければ何も出さない

export interface CheckPrecedentView {
  trials: number;
  maxShadowDamageJpy: number | null;
  text: string;
}

export interface CheckPrecedentProps {
  precedent?: CheckPrecedentView | null;
}

export function CheckPrecedent({ precedent }: CheckPrecedentProps) {
  if (!precedent) return null;
  return (
    <p className="check-precedent" style={{ margin: "4px 0 0", fontSize: 13, lineHeight: 1.5, color: "var(--muted)" }}>
      {precedent.text}
    </p>
  );
}
