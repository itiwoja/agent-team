// [最初からやり直す]：ゲストのワークスペースを捨てて、新しいデモ用のデータから始め直す（POST /guest/restart）。
// 新しい Cookie が出るので、成功したらページごと読み込み直して next（入口。用意した依頼の知らせつき：D-118）へ移る（CSRF トークンも取り直す）
import { useEffect, useId, useRef, useState } from "react";
import { api, describeError } from "../api";
import { useRestoreFocus } from "../lib/useRestoreFocus";
import { trapTab } from "../ui/trapTab";

export function RestartSheet({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  useRestoreFocus();

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (!busy) onClose();
      } else trapTab(e, sheetRef.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const restart = async () => {
    setBusy(true);
    setError(null);
    try {
      const { next } = await api.restartGuest();
      window.location.assign(next);
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  };

  return (
    <>
      <div className="sheet-backdrop" onClick={busy ? undefined : onClose} />
      <div className="sheet" ref={sheetRef} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="sheet-grip" aria-hidden="true" />
        <h2 id={titleId} className="sheet-title">最初からやり直しますか？</h2>
        <p className="sheet-body">いまの依頼・安全チェックの結果・あなたが足した悪い日は消えて、新しいデモ用のデータから始まります。動いているものは止まります。</p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="sheet-actions sheet-actions-stack">
          <button type="button" className="btn btn-danger" onClick={() => void restart()} disabled={busy}>
            {busy ? "準備しています…" : "やり直す"}
          </button>
          <button type="button" className="btn btn-ghost" ref={cancelRef} onClick={onClose} disabled={busy}>
            キャンセル
          </button>
        </div>
      </div>
    </>
  );
}
