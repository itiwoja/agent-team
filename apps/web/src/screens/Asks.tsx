// 依頼の一覧（`/asks`。?q=・?status= で絞り込みを URL に残す）。頼んだものを新しい順に、日付の小見出しで区切って並べる。
// 1件は「頼んだ文・状態の札・回答の要約」。押すとその依頼のページへ。担当が動くと（ask.* の事象）取り直す
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, describeError, type AskSummary } from "../api";
import { LoadError } from "../components/LoadError";
import { SkeletonCards } from "../components/Skeleton";
import { ASK_FILTERS, ASK_STATUS_TEXT, countByFilter, filterAsks, parseAskFilter, statusTone, type AskFilter } from "../lib/askList";
import { groupByDay } from "../lib/dayGroup";
import { formatTime } from "../lib/format";
import { Link, replaceUrl } from "../lib/router";
import { Chevron } from "../ui/icons";
import { useWorkspaceEvent } from "../workspace";

/** 一度に取る数（API の上限） */
const LIMIT = 50;

function keepInUrl(q: string, filter: AskFilter) {
  const qs = new URLSearchParams();
  if (q !== "") qs.set("q", q);
  if (filter !== "all") qs.set("status", filter);
  const search = qs.toString();
  replaceUrl(search === "" ? "/asks" : `/asks?${search}`);
}

export function Asks({ q: initialQ = "", status: initialStatus = null }: { q?: string; status?: string | null }) {
  const [asks, setAsks] = useState<AskSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState(initialQ);
  const [filter, setFilter] = useState<AskFilter>(() => parseAskFilter(initialStatus));
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(async () => {
    const my = ++seq.current;
    try {
      const r = await api.asks(LIMIT);
      if (my !== seq.current) return;
      setAsks(r.asks);
      setError(null);
    } catch (e) {
      if (my !== seq.current) return;
      setError(describeError(e));
    }
  }, []);

  useEffect(() => {
    void load();
    return () => clearTimeout(timer.current);
  }, [load]);
  useEffect(() => keepInUrl(q, filter), [q, filter]);

  // 依頼が増えた・状態が変わったら取り直す（まとめて 400ms 後に1回）
  useWorkspaceEvent((type) => {
    if (type === "reset") return void load();
    if (!type.startsWith("ask.")) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(), 400);
  });

  const counts = useMemo(() => countByFilter(asks ?? []), [asks]);
  const shown = useMemo(() => filterAsks(asks ?? [], filter, q), [asks, filter, q]);
  const groups = useMemo(() => groupByDay(shown, (a) => a.createdAt), [shown]);

  if (error && !asks) {
    return (
      <div className="asks-page">
        <h1 className="ask-head">依頼</h1>
        <LoadError message={error} onRetry={load} />
      </div>
    );
  }
  if (!asks) return <SkeletonCards count={4} head />;

  const narrowed = q.trim() !== "" || filter !== "all";
  return (
    <div className="asks-page">
      <div className="asks-head">
        <h1 className="ask-head">
          依頼
          {asks.length > 0 && (
            <span className="ask-count" aria-label={`${asks.length}件`}>
              {asks.length}
            </span>
          )}
        </h1>
      </div>

      {asks.length === 0 ? (
        <div className="done-empty asks-empty">
          <p className="muted">まだ何も頼んでいません。入口で一言頼むと、ここに並びます</p>
          <Link to="/" className="btn">
            入口へ
          </Link>
        </div>
      ) : (
        <>
          <div className="asks-filter">
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="さがす（依頼の文・回答）" aria-label="依頼をさがす" enterKeyHint="search" />
            <div className="packs-cats" role="group" aria-label="状態で絞る">
              {ASK_FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className="packs-cat"
                  aria-pressed={filter === f.id}
                  disabled={f.id !== "all" && counts[f.id] === 0 && filter !== f.id}
                  onClick={() => setFilter(f.id)}
                >
                  {f.label}
                  {f.id !== "all" && counts[f.id] > 0 && <span className="asks-cat-n">{counts[f.id]}</span>}
                </button>
              ))}
            </div>
          </div>
          {error && (
            <p className="error small" role="status">
              {error}
            </p>
          )}
          {shown.length === 0 ? (
            <div className="block card packs-empty">
              <p className="muted">当てはまる依頼がありません。</p>
              {narrowed && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setQ("");
                    setFilter("all");
                  }}
                >
                  絞り込みを外す
                </button>
              )}
            </div>
          ) : (
            groups.map((g) => (
              <section key={g.label} className="day-group" aria-label={g.label}>
                <h2 className="day-group-head">{g.label}</h2>
                <ul className="rows asks-list">
                  {g.items.map((a) => (
                    <AskRow key={a.id} ask={a} />
                  ))}
                </ul>
              </section>
            ))
          )}
          {asks.length >= LIMIT && <p className="muted small asks-limit">新しい {LIMIT} 件まで並べています</p>}
        </>
      )}
    </div>
  );
}

function AskRow({ ask: a }: { ask: AskSummary }) {
  const tone = statusTone(a.status);
  // 回答の要約（あれば）。失敗は理由の文、質問待ちは質問の文
  const sub = a.status === "failed" ? (a.failure?.message ?? null) : a.status === "waiting_input" && a.question ? a.question.text : a.answerPreview;
  return (
    <li>
      <Link to={`/asks/${encodeURIComponent(a.id)}`} className={`row ask-item is-${a.status}`}>
        <span className="ask-item-main">
          <span className="ask-item-head">
            <span className={`stage-state is-${tone}`}>{ASK_STATUS_TEXT[a.status]}</span>
            {a.trigger && <span className="ask-item-trigger">{a.trigger.label}</span>}
            <time className="ask-item-time" dateTime={a.createdAt}>
              {formatTime(a.createdAt)}
            </time>
          </span>
          <span className="row-title ask-item-text">{a.text}</span>
          {sub && <span className="row-meta ask-item-sub">{sub}</span>}
        </span>
        <Chevron dir="right" size={18} />
      </Link>
    </li>
  );
}
