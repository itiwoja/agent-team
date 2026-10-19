// 読み込めなかったとき（画面の中身がまだ無い）。理由の1行と「もう一度」を、どの画面でも同じ形で出す
import { useState } from "react";

export function LoadError({ message, onRetry }: { message: string; onRetry: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const retry = () => {
    if (busy) return;
    setBusy(true);
    void Promise.resolve(onRetry()).finally(() => setBusy(false));
  };
  return (
    <div className="load-error" role="alert">
      <p className="error">{message}</p>
      <button type="button" className="btn" disabled={busy} onClick={retry}>
        {busy ? "読み込んでいます…" : "もう一度"}
      </button>
    </div>
  );
}
