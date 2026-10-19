// SCR-019：チェック（`/check`、`?item=<key>` で該当の行を開いた状態）。見てほしいもの／やっていること／済んだもの
import { useEffect, useState } from "react";
import { api, describeError, type RunningItem } from "../api";
import { CheckRow, rowDomId } from "../components/CheckRow";
import { LoadError } from "../components/LoadError";
import { SkeletonCards } from "../components/Skeleton";
import { Link, useRoute } from "../lib/router";
import { useCheck } from "../lib/useCheck";
import { Chevron } from "../ui/icons";
import { useWorkspace } from "../workspace";

export function Check() {
  const route = useRoute();
  const focus = route.name === "check" ? route.item : null;
  const { data, items, error, failures, reload, hide, unhide } = useCheck(focus);

  // 通知から来たとき、該当の行へ（開いた状態で出る）
  useEffect(() => {
    if (!data?.focus) return;
    document
      .getElementById(rowDomId(data.focus))
      ?.scrollIntoView({ block: "center" });
  }, [data?.focus]);

  if (!data) {
    return error ? <LoadError message={error} onRetry={reload} /> : <SkeletonCards count={3} />;
  }

  return (
    <div className="check-page">
      {/* tabIndex={-1}：最後の行を ○ で消したあと、フォーカスの行き先にする（CheckRow の focusAfterGone） */}
      <h1 className="ask-head" tabIndex={-1}>
        {items.length === 0 ? (
          <span className="muted">見てほしいものはありません</span>
        ) : (
          <>
            見てほしいもの <span className="ask-count">{items.length}</span>
          </>
        )}
      </h1>
      <ul className="rows">
        {items.map((item) => (
          <CheckRow
            key={item.key}
            item={item}
            onGone={hide}
            onBack={unhide}
            failure={failures.get(item.key)}
            onReload={() => void reload()}
          />
        ))}
      </ul>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <Running items={data.running} onChanged={() => void reload()} />
      <Link to="/done" className="done-link">
        済んだもの
        <Chevron dir="right" />
      </Link>
    </div>
  );
}

/** やっていること：灰色・1行にたたむ。開くと「仕入れ係 · 在庫を確認中」を1件1行 */
function Running({
  items,
  onChanged,
}: {
  items: RunningItem[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <section className="running">
      <button
        type="button"
        className="running-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        やっていること {items.length}
        <Chevron open={open} />
      </button>
      {open && (
        <ul className="running-list">
          {items.map((r) => (
            <RunningRow key={r.taskId} item={r} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RunningRow({
  item,
  onChanged,
}: {
  item: RunningItem;
  onChanged: () => void;
}) {
  const { killSwitchEngaged, online } = useWorkspace();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const cancel = async () => {
    setBusy(true);
    try {
      await api.cancelTask(item.taskId);
      onChanged();
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  };

  return (
    <li>
      <span>
        <span className="who">{item.agent.name}</span> · {item.text}
      </span>
      {item.canCancel && !confirming && (
        <button
          type="button"
          className="link quiet"
          onClick={() => setConfirming(true)}
          disabled={killSwitchEngaged || !online}
        >
          やめる
        </button>
      )}
      {confirming && (
        <span className="inline-actions">
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy}
            onClick={() => void cancel()}
          >
            やめる
          </button>
          <button
            type="button"
            className="link quiet"
            onClick={() => setConfirming(false)}
          >
            やめない
          </button>
        </span>
      )}
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </li>
  );
}
