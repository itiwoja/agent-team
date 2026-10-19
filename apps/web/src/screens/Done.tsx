// 済んだもの（`/done`）：チェックした行の履歴。新しい順に、日付の小見出しで区切る
import { useCallback, useEffect, useState } from "react";
import { api, describeError, type DoneItem } from "../api";
import { LoadError } from "../components/LoadError";
import { SkeletonCards } from "../components/Skeleton";
import { groupByDay } from "../lib/dayGroup";
import { formatTime } from "../lib/format";
import { Link } from "../lib/router";
import { Chevron } from "../ui/icons";

const OUTCOME: Record<NonNullable<DoneItem["outcome"]>, string> = {
  approved: "送りました",
  rejected: "送りませんでした",
  expired: "期限切れ",
};

/** 2行目の時刻（H:mm）が subtitle に入っているか（報告の subtitle はサーバーが「担当 · 20:55」の形で作る） */
const hasTime = (s: string): boolean => /\d{1,2}:\d{2}/.test(s);

/**
 * 結果の札と、2行目（subtitle · 時刻）。
 * 送る前の確認の subtitle はサーバーが「担当 · 送りました」まで入れて作る（apps/app/src/check/items.ts の buildDone）ので、
 * 札と同じ語を含む部分は subtitle から外す（「送りました · 仕入れ係 · 送りました」にならない）。
 * 報告の subtitle に時刻が入っていれば（練習・記録・仕事の報告）、済んだ時刻を重ねて出さない
 */
function describeDone(i: Pick<DoneItem, "outcome" | "subtitle" | "doneAt">): { outcome: string | null; meta: string } {
  const outcome = i.outcome ? OUTCOME[i.outcome] : null;
  const sub = i.subtitle ?? "";
  const subParts = sub.split(" · ").filter((p) => p && (outcome === null || !p.includes(outcome)));
  const meta = [subParts.join(" · ") || null, hasTime(sub) ? null : formatTime(i.doneAt)].filter(Boolean).join(" · ");
  return { outcome, meta };
}

export function Done() {
  const [items, setItems] = useState<DoneItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    return api
      .done()
      .then((r) => setItems(r.items))
      .catch((e: unknown) => setError(describeError(e)));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (error && !items) return <LoadError message={error} onRetry={load} />;
  if (!items) return <SkeletonCards count={3} />;
  const groups = groupByDay(items, (i) => i.doneAt);
  return (
    <div className="check-page">
      <h1 className="ask-head">済んだもの</h1>
      {items.length === 0 ? (
        <div className="done-empty">
          <p className="muted">チェックしたものがここに並びます</p>
          <Link to="/check" className="btn">
            チェックへ
          </Link>
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.label} className="day-group">
            <h2 className="day-group-head">{g.label}</h2>
            <ul className="rows">
              {g.items.map((i) => (
                <DoneCard key={i.key} item={i} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

/** 1件。askId があるときは行全体を「この依頼のページ」へのリンクにする（無いときは押せない） */
function DoneCard({ item: i }: { item: DoneItem }) {
  const { outcome, meta } = describeDone(i);
  const body = (
    <div className="done-main">
      {outcome && <span className={`done-outcome is-${i.outcome}`}>{outcome}</span>}
      <div className="row-title">{i.title}</div>
      {meta && <div className="row-meta">{meta}</div>}
    </div>
  );
  return (
    <li className="done-item">
      {i.askId ? (
        <Link to={`/asks/${i.askId}`} className="row done done-card is-link">
          {body}
          <span className="done-chev">
            <Chevron dir="right" size={18} />
          </span>
        </Link>
      ) : (
        <div className="row done done-card">{body}</div>
      )}
      {i.calendarLink && (
        <a className="done-cal" href={i.calendarLink} target="_blank" rel="noopener noreferrer">
          カレンダーで開く
        </a>
      )}
    </li>
  );
}
