// GitHub の接続の案内とメニュー（18 §3.7）。つなぐ入口はメニュー（AppHeader）にあり、GitHub の依頼なのに未接続のときは依頼の画面にも出す。
// この環境で使えないときは何も出さない。つなぐのは通常の画面遷移（GitHub のインストールの画面へ行くため SPA の外へ出る）
import { useState } from "react";
import { api } from "../api";
import { useWorkspace } from "../workspace";

/** つなぐ（GitHub App のインストールの画面へ。入れてある人は GitHub の画面で「Configure」から戻れる） */
export const GITHUB_CONNECT_HREF = "/api/v1/connect/github/start";

/** 依頼の画面の案内：GitHub の依頼なのに未接続のとき、つなぐと PR まで出せると伝える */
export function GithubHint({ needs }: { needs: "gcal" | "github" | null | undefined }) {
  const { github } = useWorkspace();
  if (needs !== "github" || !github.available || github.connected) return null;
  return (
    <p className="gcal-hint" role="note">
      GitHub をつなぐと、リポジトリを直して PR を出すところまで任せられます{" "}
      <a className="gcal-link" href={GITHUB_CONNECT_HREF}>
        GitHub をつなぐ
      </a>
    </p>
  );
}

/**
 * メニューの GitHub の欄：つなぐ／つないだアカウント・main への直接の書き込みの許可・対象のリポジトリを変える・切断。
 * 許可をオンにするときは確かめる（オンでも、書き込みは毎回あなたの確認に回る）
 */
export function GithubMenuSection() {
  const { github, setGithub } = useWorkspace();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!github.available) return null;
  if (!github.connected) {
    return (
      <a className="drawer-item" href={GITHUB_CONNECT_HREF}>
        <GithubIcon />
        <span>GitHub をつなぐ</span>
      </a>
    );
  }

  const toggle = async (allow: boolean) => {
    if (allow && !window.confirm("main（既定のブランチ）への直接の書き込みを許しますか？\n許しても、書き込みは毎回あなたの確認に回ります。ふだんは新しいブランチから PR を出します。")) return;
    setBusy(true);
    try {
      const r = await api.setGithubProtectedWrite(allow);
      setGithub({ ...github, allowProtectedWrite: r.allowProtectedWrite });
      setError(null);
    } catch {
      setError("切り替えられませんでした。もう一度お試しください");
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    setBusy(true);
    try {
      await api.disconnectGithub();
      setGithub({ ...github, connected: false, login: null, allowProtectedWrite: false, settingsUrl: null });
      setError(null);
    } catch {
      setError("切断できませんでした。もう一度お試しください");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="drawer-gcal">
      <p className="muted small">GitHub：{github.login}</p>
      <label className="drawer-toggle small">
        <input type="checkbox" checked={github.allowProtectedWrite} disabled={busy} onChange={(e) => void toggle(e.target.checked)} />
        <span>main への直接の書き込みを許可</span>
      </label>
      <p className="muted small">{github.allowProtectedWrite ? "main にも書けます（毎回あなたの確認のあと）" : "main は守られています。変更は新しいブランチから PR で出します"}</p>
      {github.settingsUrl && (
        <a className="small" href={github.settingsUrl} target="_blank" rel="noopener noreferrer">
          任せるリポジトリを GitHub で選ぶ
        </a>
      )}
      <button type="button" className="btn btn-ghost drawer-restart" disabled={busy} onClick={() => void disconnect()}>
        GitHub を切断
      </button>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

function GithubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="6" cy="18" r="2.2" />
      <circle cx="18" cy="8" r="2.2" />
      <path d="M6 8.2v7.6M18 10.2c0 4-6 3-11 6" />
    </svg>
  );
}
