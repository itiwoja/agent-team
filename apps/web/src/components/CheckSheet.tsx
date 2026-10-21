// 見てほしいものシート：ヘッダーの件数の印から、いまいる画面の上に開く（スマホは下から、広い画面は右から）。
// 承認・答える・既読は /check と同じ CheckRow でその場でできる。閉じても、取り消し猶予中の ○ は
// モジュールのストア（lib/undo.ts）が持っているので、確定も取り消しも壊れない（開き直すと行は「送ります…」のまま続く）
import { useEffect, useRef } from "react";
import { CheckRow } from "./CheckRow";
import { SkeletonLines } from "./Skeleton";
import { Link } from "../lib/router";
import { useCheck } from "../lib/useCheck";
import { useRestoreFocus } from "../lib/useRestoreFocus";
import { trapTab } from "../ui/trapTab";
import { Chevron, CloseIcon } from "../ui/icons";

export function CheckSheet({ onClose }: { onClose: () => void }) {
  const { data, items, error, failures, reload, hide, unhide } = useCheck(null);
  const ref = useRef<HTMLDivElement>(null);
  useRestoreFocus();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else trapTab(e, ref.current);
    };
    window.addEventListener("keydown", onKey);
    ref.current?.querySelector<HTMLElement>("h1")?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      {/* check-page：最後の行を消したあとの focusAfterGone が見出し（h1[tabindex]）を探すため */}
      <div className="sheet check-sheet check-page" ref={ref} role="dialog" aria-modal="true" aria-labelledby="check-sheet-title">
        <div className="sheet-grip" aria-hidden="true" />
        <div className="check-sheet-head">
          <h1 id="check-sheet-title" className="sheet-title" tabIndex={-1}>
            見てほしいもの
            {data && items.length > 0 && <span className="check-sheet-count"> {items.length}</span>}
          </h1>
          <button type="button" className="icon-btn" aria-label="閉じる" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="check-sheet-body">
          {!data ? (
            error ? (
              <div>
                <p className="error" role="alert">
                  {error}
                </p>
                <button type="button" className="btn btn-ghost" onClick={() => void reload()}>
                  もう一度読む
                </button>
              </div>
            ) : (
              <SkeletonLines lines={3} />
            )
          ) : items.length === 0 ? (
            <p className="muted check-sheet-empty">いま見てほしいものはありません</p>
          ) : (
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
          )}
          {data && error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
        <Link to="/check" className="done-link check-sheet-all" onClick={onClose}>
          チェックをすべて見る
          <Chevron dir="right" />
        </Link>
      </div>
    </>
  );
}
