// AppHeader：左は ≡（メニュー：依頼・チェック・エージェント・パック）、真ん中はひとつ上へ戻る矢印（行き先は lib/screen.ts の backOf。入口自体では出さない）。
// 右は見てほしいものがあるときだけ、件数の印つきのチェックへの入口（チェックの画面自身では出さない）。無いときは左と同じ幅の空きにして、真ん中を中央に保つ。
// 全部止めている間は帯で知らせる。
import { useCallback, useEffect, useRef, useState } from "react";
import type { AskSummary } from "../api";
import { filterOf } from "../lib/askList";
import { createPortal } from "react-dom";
import { api } from "../api";
import { Link, useRoute } from "../lib/router";
import { trapTab } from "../ui/trapTab";
import { connectHref } from "./GoogleCalendarLine";
import { GithubMenuSection } from "./GithubLine";
import { RestartSheet } from "./RestartSheet";
import { AgentsIcon, BackIcon, CalendarIcon, CheckIcon, Chevron, CloseIcon, ComposeIcon, MenuIcon, PacksIcon, TasksIcon } from "../ui/icons";
import { useWorkspace } from "../workspace";

export function AppHeader({ back }: { back: { to: string; label: string } | null }) {
  const { killSwitchEngaged, online, counts } = useWorkspace();
  const route = useRoute();
  const attention = counts?.attention ?? 0;
  const [menuOpen, setMenuOpen] = useState(false);
  const [restartOpen, setRestartOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const appOf = () => headerRef.current?.closest<HTMLElement>(".app") ?? null;
  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    // inert のままだとフォーカスが戻らないので、effect を待たず先に外す
    const app = appOf();
    if (app) app.inert = false;
    menuBtnRef.current?.focus();
  }, []);

  // メニューが開いている間、背後（header と main）を Tab・クリック・読み上げから外す。メニュー自体は body に出す
  useEffect(() => {
    if (!menuOpen) return;
    const app = appOf();
    if (!app) return;
    app.inert = true;
    return () => {
      app.inert = false;
    };
  }, [menuOpen]);

  return (
    <>
      <header className="appheader" ref={headerRef}>
        <button
          type="button"
          ref={menuBtnRef}
          className="icon-btn"
          aria-label="メニュー"
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <MenuIcon />
        </button>
        <div className="appheader-title">
          {back && (
            <Link to={back.to} className="appheader-back">
              <BackIcon size={18} />
              <span>{back.label}</span>
            </Link>
          )}
        </div>
        {attention > 0 && route.name !== "check" ? (
          <Link to="/check" className="icon-btn appheader-check" aria-label={`見てほしいもの ${attention}件`}>
            <CheckIcon size={22} />
            <span className={counts?.hasApproval ? "appheader-badge is-gate" : "appheader-badge"} aria-hidden="true">
              {attention > 99 ? "99+" : attention}
            </span>
          </Link>
        ) : (
          <span className="appheader-spacer" aria-hidden="true" />
        )}
      </header>
      {killSwitchEngaged && (
        <p className="banner banner-danger" role="status">
          全部止めています
        </p>
      )}
      {!online && (
        <p className="banner banner-muted" role="status">
          つながっていません
        </p>
      )}
      {menuOpen && createPortal(<Menu attention={counts?.attention ?? 0} onClose={closeMenu} onRestart={() => setRestartOpen(true)} />, document.body)}
      {restartOpen && <RestartSheet onClose={() => setRestartOpen(false)} />}
    </>
  );
}

/** メニューに出す最近の依頼の数 */
const RECENT = 5;

function Menu({ attention, onClose, onRestart }: { attention: number; onClose: () => void; onRestart: () => void }) {
  const { workspace, signOut, google, setGoogle } = useWorkspace();
  const route = useRoute();
  const [gcalError, setGcalError] = useState(false);
  const disconnectGoogle = async () => {
    try {
      await api.disconnectGoogle();
      setGoogle({ ...google, connected: false, email: null });
      setGcalError(false);
    } catch {
      setGcalError(true);
    }
  };
  const ref = useRef<HTMLDivElement>(null);
  // 今日使える費用はログイン時の値のままだと古いので、開くたびに取り直す（取れなければ手元の値）
  const [remainingUsd, setRemainingUsd] = useState(workspace.budget.remainingUsd);
  useEffect(() => {
    if (!workspace.guest) return;
    let alive = true;
    api
      .me()
      .then((m) => alive && setRemainingUsd(m.workspace.budget.remainingUsd))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [workspace.guest]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else trapTab(e, ref.current);
    };
    window.addEventListener("keydown", onKey);
    ref.current?.querySelector<HTMLElement>("a,button")?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const cur = (name: string) => (route.name === name ? "page" : undefined);
  // 最近の依頼（開くたびに取り直す。取れなければ出さない）
  const [recent, setRecent] = useState<AskSummary[] | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .asks(RECENT)
      .then((r) => alive && setRecent(r.asks))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const currentAskId = route.name === "ask" ? route.askId : null;

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer" ref={ref} role="dialog" aria-modal="true" aria-label="メニュー">
        <div className="drawer-head">
          <Link to="/" className="drawer-new" onClick={onClose}>
            <span className="logo" aria-hidden="true">
              ◎
            </span>
            <span>Makase</span>
          </Link>
          <button type="button" className="icon-btn" aria-label="閉じる" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        {workspace.guest && (
          <p className="drawer-note muted small">
            ゲスト・あと{workspace.guest.daysLeft}日
            <br />
            今日使える AI の費用：あと ${Number(remainingUsd).toFixed(2)}
          </p>
        )}
        {workspace.guest && (
          <button
            type="button"
            className="btn btn-ghost drawer-restart"
            onClick={() => {
              onClose();
              onRestart();
            }}
          >
            最初からやり直す
          </button>
        )}
        <nav className="drawer-nav" aria-label="画面">
          <Link to="/" className={"drawer-item" + (route.name === "home" ? " is-current" : "")} aria-current={cur("home")} onClick={onClose}>
            <ComposeIcon />
            <span>任せる</span>
          </Link>
          <Link to="/asks" className={"drawer-item" + (route.name === "asks" ? " is-current" : "")} aria-current={cur("asks")} onClick={onClose}>
            <TasksIcon />
            <span>依頼</span>
          </Link>
          <Link to="/check" className={"drawer-item" + (route.name === "check" ? " is-current" : "")} aria-current={cur("check")} onClick={onClose}>
            <CheckIcon />
            <span>チェック</span>
            {attention > 0 && (
              <span className="count" aria-label={`${attention}件`}>
                {attention}
              </span>
            )}
          </Link>
          {/* 済んだもの（/done）はメニューに出さない。チェックの末尾の「済んだもの」から開く */}
          <Link to="/agents" className={"drawer-item" + (route.name === "agents" ? " is-current" : "")} aria-current={cur("agents")} onClick={onClose}>
            <AgentsIcon />
            <span>エージェント</span>
          </Link>
          {/* パック（D-116）：エージェント・スキル・スクリプトの詰め合わせを入れる棚 */}
          <Link to="/packs" className={"drawer-item" + (route.name === "packs" || route.name === "pack" ? " is-current" : "")} aria-current={cur("packs")} onClick={onClose}>
            <PacksIcon />
            <span>パック</span>
          </Link>
          {/* 記録（SCR-010・/audit）はメニューに出さない。合格証の「監査ログ #N」から開く */}
          {recent && recent.length > 0 && (
            <section className="drawer-recent" aria-label="最近の依頼">
              <p className="drawer-recent-head">最近の依頼</p>
              {recent.map((a) => {
                const f = filterOf(a.status);
                return (
                  <Link
                    key={a.id}
                    to={`/asks/${encodeURIComponent(a.id)}`}
                    className={"drawer-recent-item" + (a.id === currentAskId ? " is-current" : "")}
                    aria-current={a.id === currentAskId ? "page" : undefined}
                    onClick={onClose}
                  >
                    <span className="drawer-recent-text">{a.text}</span>
                    {(f === "active" || f === "waiting" || f === "failed") && (
                      <span className={"drawer-recent-dot" + (f === "failed" ? " is-failed" : "")} role="img" aria-label={f === "failed" ? "失敗" : f === "waiting" ? "手が要ります" : "動いています"} />
                    )}
                  </Link>
                );
              })}
              {recent.length >= RECENT && (
                <Link to="/asks" className="drawer-recent-all" onClick={onClose}>
                  すべて見る <Chevron dir="right" size={14} />
                </Link>
              )}
            </section>
          )}
        </nav>
        {/* つなぐ入口（入口の画面からは外した。カレンダーの依頼を出したときは依頼の画面にも出る） */}
        {google.available && !google.connected && (
          <a className="drawer-item" href={connectHref()}>
            <CalendarIcon />
            <span>Google カレンダーをつなぐ</span>
          </a>
        )}
        {google.available && google.connected && (
          <div className="drawer-gcal">
            <p className="muted small">Google カレンダー：{google.email}</p>
            <button type="button" className="btn btn-ghost drawer-restart" onClick={() => void disconnectGoogle()}>
              Google カレンダーを切断
            </button>
            {gcalError && <p className="error small">切断できませんでした。もう一度お試しください</p>}
          </div>
        )}
        <GithubMenuSection />
        <div className="drawer-foot">
          <button type="button" className="btn btn-ghost" onClick={() => void signOut()}>
            出る
          </button>
        </div>
      </div>
    </>
  );
}
