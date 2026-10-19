// 自分の依頼の安全チェックの「まず3件 → 途中結果 → 残りは裏で」の1行（Issue #12）。数字は判定済みの行からの暫定で、
// 安全チェック済み（合格証）はすべて終わってから決まる（意味は変えない）。利用者向けの語は「安全チェック」「悪い日」「暫定」（#16 B案）
import { FIRST_BATCH_SIZE } from "../../../app/src/rehearsal/first-batch";
import { INITIAL_MINUTES_PER_CASE } from "./rehearsal";

export { FIRST_BATCH_SIZE };

export interface FirstBatchInput {
  /** 走行の trigger（initial だけが対象） */
  trigger: string;
  /** 走っているか（queued・generating・running） */
  active: boolean;
  /** 台本で再現した走行か（対象外） */
  scripted: boolean;
  /** 判定が出た件数（負は 0、total 超過は total として扱う） */
  done: number;
  /** 悪い日の件数（分からなければ null） */
  total: number | null;
}

/**
 * 走行中の1行。
 * - 判定済みが FIRST_BATCH_SIZE 未満：「まず3件の悪い日を試しています。途中の結果は約N分で出ます」
 * - FIRST_BATCH_SIZE 以上で残りあり：「ここまでの数字は N件分の暫定です。残りの悪い日 M件も裏で試しています（約K分）。…」
 * - 対象外（走っていない・trigger が initial 以外・台本の再現・件数不明・件数が FIRST_BATCH_SIZE 以下・残り 0）は null
 * 分は 1件あたり INITIAL_MINUTES_PER_CASE 分の目安（最低 1分）。
 */
export function firstBatchNote(i: FirstBatchInput): string | null {
  if (!i.active || i.trigger !== "initial" || i.scripted) return null;
  if (i.total === null || i.total <= FIRST_BATCH_SIZE) return null;
  const done = Math.max(0, Math.min(i.done, i.total));
  const rest = i.total - done;
  if (rest <= 0) return null;
  if (done < FIRST_BATCH_SIZE) {
    const m = minutes(FIRST_BATCH_SIZE - done);
    return `まず${FIRST_BATCH_SIZE}件の悪い日を試しています。途中の結果は約${m}分で出ます`;
  }
  return `ここまでの数字は ${done}件分の暫定です。残りの悪い日 ${rest}件も裏で試しています（約${minutes(rest)}分）。安全チェックの結果は、すべて終わってから出ます`;
}

function minutes(cases: number): number {
  return Math.max(1, Math.round(cases * INITIAL_MINUTES_PER_CASE));
}
