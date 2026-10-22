// SCR-010 記録（`/audit`）：監査ログの一覧（新しい順）と、ハッシュの鎖の検証。
// ?seq= で来たら、その行から古い順に取り、行を強調して開く（検証の結果の「#348」から）。
// 「出力」（API-025）は API が無いので出さない。期間の絞り込みは省いた
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, describeError, type AuditLogItem } from "../api";
import { actorLabel, cursorAt, eventTypeLabel, eventTypeOptions, shortHash, summarizeAudit } from "../lib/audit";
import { SkeletonLines } from "../components/Skeleton";
import { groupByDay } from "../lib/dayGroup";
import { Link, navigate } from "../lib/router";
import { useWorkspace } from "../workspace";

const PAGE = 50;

type Verify =
  | { state: "idle" }
  | { state: "running" }
  | { state: "ok"; count: number }
  | { state: "ng"; count: number; broken: number | null }
  | { state: "error"; message: string };

const count = (n: number) => n.toLocaleString("ja-JP");
const rowId = (seq: number) => `audit-${seq}`;
/** 行の時刻は HH:mm:ss（日付は小見出しで出す） */
const clock = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
};

export function Audit({ seq }: { seq: number | null }) {
  const { workspace, me } = useWorkspace();
  const [eventType, setEventType] = useState("");
  const [items, setItems] = useState<AuditLogItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const [verify, setVerify] = useState<Verify>({ state: "idle" });
  const [reload, setReload] = useState(0);
  // 描いた後に寄せる行（?seq= で来たとき、最初のページの読み込み後に1回だけ）
  const [scrollTo, setScrollTo] = useState<number | null>(null);
  // 古い応答で上書きしない（絞り込みを続けて変えたとき）
  const reqRef = useRef(0);

  const remember = useCallback((rows: AuditLogItem[]) => {
    setSeen((prev) => {
      if (rows.every((r) => prev.has(r.eventType))) return prev;
      const next = new Set(prev);
      rows.forEach((r) => next.add(r.eventType));
      return next;
    });
  }, []);

  // 絞り込み・?seq= が変わったら最初のページから取り直す
  useEffect(() => {
    const req = ++reqRef.current;
    setLoading(true);
    setError(null);
    api
      .auditLogs(workspace.id, { limit: PAGE, eventType, ...(seq !== null ? { cursor: cursorAt(seq) } : {}) })
      .then((r) => {
        if (req !== reqRef.current) return;
        setItems(r.items);
        setNextCursor(r.nextCursor);
        remember(r.items);
        if (seq !== null) {
          setOpen(new Set([seq]));
          setScrollTo(seq);
        }
      })
      .catch((e: unknown) => {
        if (req === reqRef.current) setError(describeError(e));
      })
      .finally(() => {
        if (req === reqRef.current) setLoading(false);
      });
  }, [workspace.id, eventType, seq, reload, remember]);

  useEffect(() => {
    if (scrollTo === null) return;
    document.getElementById(rowId(scrollTo))?.scrollIntoView({ block: "center" });
    setScrollTo(null);
  }, [scrollTo]);

  const more = () => {
    if (!nextCursor) return;
    const req = ++reqRef.current;
    setLoading(true);
    api
      .auditLogs(workspace.id, { limit: PAGE, eventType, cursor: nextCursor })
      .then((r) => {
        if (req !== reqRef.current) return;
        setItems((prev) => [...(prev ?? []), ...r.items]);
        setNextCursor(r.nextCursor);
        remember(r.items);
      })
      .catch((e: unknown) => {
        if (req === reqRef.current) setError(describeError(e));
      })
      .finally(() => {
        if (req === reqRef.current) setLoading(false);
      });
  };

  const runVerify = async () => {
    setVerify({ state: "running" });
    try {
      const r = await api.verifyAuditLogs(workspace.id);
      if (r.ok) {
        setVerify({ state: "ok", count: r.checkedCount });
        return;
      }
      setVerify({ state: "ng", count: r.checkedCount, broken: r.firstBrokenSeq });
      if (r.firstBrokenSeq !== null) showRow(r.firstBrokenSeq);
    } catch (e) {
      setVerify({ state: "error", message: describeError(e) });
    }
  };

  /** 読み込み済みならその行へ。なければ絞り込みを外して、その行から取り直す */
  const showRow = (target: number) => {
    const el = document.getElementById(rowId(target));
    if (el) {
      setOpen((prev) => new Set(prev).add(target));
      el.scrollIntoView({ block: "center" });
      return;
    }
    setEventType("");
    navigate(`/audit?seq=${target}`, { replace: true });
  };

  const toggle = (s: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const options = useMemo(() => eventTypeOptions(seen), [seen]);
  const days = useMemo(() => groupByDay(items ?? [], (i) => i.occurredAt), [items]);
  const broken = verify.state === "ng" ? verify.broken : null;
  const filtered = eventType !== "";

  return (
    <div className="check-page audit-page">
      <div className="audit-head">
        <h1 className="ask-head">記録</h1>
        <button type="button" className="btn btn-primary audit-verify-btn" onClick={() => void runVerify()} disabled={verify.state === "running"}>
          {verify.state === "running" ? "検証しています…" : "整合性を検証"}
        </button>
      </div>
      <p className="muted audit-lead">起きたことを書き換えられない形で残しています。</p>

      <VerifyLine verify={verify} onShow={showRow} />

      <div className="audit-filter">
        <label className="audit-field">
          <span className="muted small">種類</span>
          <select value={eventType} onChange={(e) => setEventType(e.target.value)}>
            <option value="">すべて</option>
            {options.map((t) => (
              <option key={t} value={t}>
                {eventTypeLabel(t) === t ? t : `${eventTypeLabel(t)}（${t}）`}
              </option>
            ))}
          </select>
        </label>
      </div>

      {seq !== null && (
        <p className="muted small audit-from">
          #{seq} から古い順に表示しています ·{" "}
          <Link to="/audit" className="link">
            新しい記録から見る
          </Link>
        </p>
      )}

      {error && (
        <div className="audit-error">
          <p className="error" role="alert">
            {error}
          </p>
          <button type="button" className="btn" onClick={() => setReload((n) => n + 1)}>
            もう一度読み込む
          </button>
        </div>
      )}
      {!items && loading && <SkeletonLines lines={5} heading />}
      {items && items.length === 0 && !loading && !error && <p className="muted">{filtered ? "合う記録がありません" : "まだ記録がありません"}</p>}

      {items && items.length > 0 && (
        <div aria-busy={loading}>
          {days.map((g) => (
            <section key={g.label} className="day-group">
              <h2 className="day-group-head">{g.label}</h2>
              <ol className="audit-list">
                {g.items.map((i) => (
                  <AuditRow
                    key={i.seq}
                    item={i}
                    selfUserId={me.user.id}
                    open={open.has(i.seq)}
                    target={i.seq === seq}
                    broken={i.seq === broken}
                    onToggle={() => toggle(i.seq)}
                  />
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}

      {items && nextCursor && (
        <div className="audit-more">
          <button type="button" className="btn btn-ghost" onClick={more} disabled={loading}>
            {loading ? "読み込んでいます…" : "もっと見る"}
          </button>
        </div>
      )}
    </div>
  );
}

function VerifyLine({ verify, onShow }: { verify: Verify; onShow: (seq: number) => void }) {
  switch (verify.state) {
    case "idle":
      return null;
    case "running":
      return (
        <p className="audit-verify" role="status">
          すべての記録のハッシュを計算し直しています…
        </p>
      );
    case "ok":
      return (
        <p className="audit-verify is-ok" role="status">
          ✓ {count(verify.count)}件、改ざんなし
        </p>
      );
    case "ng":
      return (
        <p className="audit-verify is-ng" role="alert">
          ✕ 書き換えられた跡があります（{count(verify.count)}件を確認）
          {verify.broken !== null && (
            <>
              {" "}
              · 最初に合わないのは{" "}
              <button type="button" className="link audit-broken-link" onClick={() => onShow(verify.broken!)}>
                #{verify.broken}
              </button>
            </>
          )}
        </p>
      );
    case "error":
      return (
        <p className="error" role="alert">
          検証できませんでした：{verify.message}
        </p>
      );
  }
}

function AuditRow({
  item,
  selfUserId,
  open,
  target,
  broken,
  onToggle,
}: {
  item: AuditLogItem;
  selfUserId: string;
  open: boolean;
  target: boolean;
  broken: boolean;
  onToggle: () => void;
}) {
  const detailId = `${rowId(item.seq)}-detail`;
  // 閉じた行では2行で省くので、開いた中の先頭に全文を出す（F-022）
  const summary = summarizeAudit(item);
  return (
    <li
      id={rowId(item.seq)}
      className={
        "audit-row" +
        (target ? " is-target" : "") +
        (broken ? " is-broken" : "") +
        // AI の呼び出しは重要度の低い行なので、本文を目立たせない
        (item.eventType === "llm.called" ? " is-quiet" : "")
      }
    >
      <button type="button" className="audit-main" aria-expanded={open} aria-controls={detailId} onClick={onToggle}>
        <span className="audit-top">
          <span className="audit-seq mono">#{item.seq}</span>
          <span className="audit-time muted mono">{clock(item.occurredAt)}</span>
          <span className="audit-type" title={item.eventType}>
            {eventTypeLabel(item.eventType)}
          </span>
        </span>
        <span className="audit-summary">{summary}</span>
        <span className="audit-meta muted">
          {actorLabel(item, selfUserId)} · <span className="mono">{shortHash(item.hash)}</span>
        </span>
      </button>
      {open && (
        <div id={detailId} className="audit-detail">
          <dl className="kv">
            <dt>要約</dt>
            <dd>{summary}</dd>
            <dt>種類</dt>
            <dd className="mono">{item.eventType}</dd>
            <dt>実行者</dt>
            <dd>
              {item.actorType} / <span className="mono">{item.actorId}</span>
            </dd>
            {item.taskId && (
              <>
                <dt>仕事</dt>
                <dd className="mono">{item.taskId}</dd>
              </>
            )}
            <dt>ハッシュ</dt>
            <dd className="mono audit-hash">{item.hash}</dd>
            <dt>1つ前</dt>
            <dd className="mono audit-hash">{item.prevHash}</dd>
          </dl>
          <pre className="audit-json">{JSON.stringify(item.payload, null, 2)}</pre>
        </div>
      )}
    </li>
  );
}
