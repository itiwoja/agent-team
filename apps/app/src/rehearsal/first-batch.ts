// 自分の依頼の安全チェックを「まず3件 → 途中結果 → 残りは裏で」にするための、走らせる順番の決め方（Issue #12）。
// 生成・保存・合格証の条件は変えない。並べ替えるのは走らせる順番（ordinal）だけ。
// 純粋関数（I/O・時刻なし）。web（apps/web/src/lib/firstBatch.ts）も FIRST_BATCH_SIZE をここから読む

/** 最初に結果を出す件数 */
export const FIRST_BATCH_SIZE = 3;
/** 最初に走らせたい障害（効きの大きいもの。この順に1件ずつ選ぶ）。F-01 は agentRunsFor で担当が2回走り重いので最後 */
export const FIRST_BATCH_FAULTS = ["F-05", "F-03", "F-01"] as const;

/**
 * 試験の並びを、FIRST_BATCH_FAULTS を含む試験が先頭に来るように並べ替える（安定。元の配列は変えない）。
 *
 * 入力：`id` と `fault_ids` を持つ試験の配列（`RehearsalCaseRow` がそのまま合う）。
 * 出力：同じ要素・同じ件数の新しい配列（id が一意である前提で、重複・欠落なし）。
 *
 * - 障害ごとに、その障害を含むまだ選んでいない最初の試験を1件選ぶ（F-05 → F-03 → F-01 の順）
 * - 選べた件数が FIRST_BATCH_SIZE に満たなければ、残りの先頭から足して FIRST_BATCH_SIZE 件にする
 * - それ以外は元の順のまま後ろに続ける
 *
 * 境界条件：
 * - 件数が FIRST_BATCH_SIZE 以下（0件を含む）なら元の順のまま返す（新しい配列）
 * - 1件の試験が複数の障害を含んでも、同じ試験は2回選ばない
 * - 対象の障害がどの試験にもなければ、元の順の先頭 FIRST_BATCH_SIZE 件がそのまま先頭になる
 */
export function orderFirstBatch<C extends { id: string; fault_ids: readonly string[] }>(cases: readonly C[]): C[] {
  if (cases.length <= FIRST_BATCH_SIZE) return [...cases];
  const picked: C[] = [];
  const used = new Set<string>();
  for (const f of FIRST_BATCH_FAULTS) {
    const c = cases.find((x) => !used.has(x.id) && x.fault_ids.includes(f));
    if (c) {
      picked.push(c);
      used.add(c.id);
    }
  }
  for (const c of cases) {
    if (picked.length >= FIRST_BATCH_SIZE) break;
    if (!used.has(c.id)) {
      picked.push(c);
      used.add(c.id);
    }
  }
  return [...picked, ...cases.filter((c) => !used.has(c.id))];
}
