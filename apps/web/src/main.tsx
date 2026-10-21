import { StrictMode, useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { api, onUnauthorized, type Me, type SessionState } from "./api";
import { AppHeader } from "./components/AppHeader";
import { AskComposerSheet } from "./components/AskComposerSheet";
import { Notices } from "./components/Notices";
import { JUDGE_TOKEN_NOTE } from "./lib/format";
import { installHistory, Link, navigate, takePendingScroll, useRoute, type Route } from "./lib/router";
import { restoreWhenTall } from "./lib/scrollMemory";
import { backOf, titleOf } from "./lib/screen";
import { ENTER_ASK_MS } from "./lib/generation";
import { useAskGeneration } from "./lib/useAskGeneration";
import { composeTitle, useScreenTitleOverride } from "./lib/title";
import { useViewportHeight } from "./lib/viewport";
import { Agents } from "./screens/Agents";
import { Asks } from "./screens/Asks";
import { PackDetail, Packs } from "./screens/Packs";
import { AskPage } from "./screens/AskPage";
import { Audit } from "./screens/Audit";
import { Check } from "./screens/Check";
import { Done } from "./screens/Done";
import { Entrance } from "./screens/Entrance";
import { useWorkspace, WorkspaceProvider } from "./workspace";
import "./styles.css";
import "./styles/shell.css";
import "./styles/entrance.css";
import "./styles/check.css";
import "./styles/ask.css";
import "./styles/audit.css";
import "./styles/agents.css";
import "./styles/packs.css";
import "./styles/pack-workspace.css";
import "./styles/pack-ceremony.css";
import "./styles/markdown.css";
import "./styles/avatar.css";
import "./styles/notice.css";
import "./styles/asks.css";

type Session = { state: "loading" } | SessionState;

function App() {
  const [session, setSession] = useState<Session>({ state: "loading" });

  const refresh = useCallback(() => {
    return api
      .session()
      .then(setSession)
      .catch(() => setSession({ state: "signed_out" }));
  }, []);

  useEffect(() => {
    void refresh();
    return onUnauthorized(() => setSession({ state: "signed_out" }));
  }, [refresh]);

  switch (session.state) {
    case "loading":
      return <Loading />;
    case "setup_required":
      return <SetupRequired missing={session.missing} />;
    case "signed_out":
      return <Entry onSignedIn={refresh} localEntry={session.localEntry === true} />;
    case "signed_in":
      return <Shell onSignedOut={refresh} />;
  }
}

/** 起動時（session→me）の読み込み中。index.html の #root にも同じ文の静的な骨がある */
function Loading() {
  return (
    <main className="center">
      <p className="muted" role="status">
        読み込んでいます…
      </p>
    </main>
  );
}

function SetupRequired({ missing }: { missing: string[] }) {
  return (
    <main className="center">
      <h1>準備中</h1>
      <p>次の環境変数を設定してください。</p>
      <ul className="mono">
        {missing.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
    </main>
  );
}

// StrictMode の二重実行で自動の入場を2回走らせない（ログアウトしたあとは自動では入らない）
let localAutoEntered = false;

function Entry({ onSignedIn, localEntry }: { onSignedIn: () => Promise<void>; localEntry: boolean }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const enterBy = async (call: () => ReturnType<typeof api.enter>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await call();
      // どちらのトークンでも入口（SCR-020）へ。審査用のトークンは `/?prepared=` 付きで、入口が「用意した依頼が待っています」を出す（D-118）
      if (res.next && res.next !== "/") navigate(res.next, { replace: true });
      await onSignedIn();
    } catch (err) {
      const status = (err as { status?: number }).status;
      setError(status === 401 ? "トークンが違います" : "入れませんでした。時間をおいて試してください");
    } finally {
      // 入れた直後の GET /session が失敗しても「入る」を押せるままにする（成功なら入口ごと消える）
      setBusy(false);
    }
  };
  const enterWith = (value: string) => enterBy(() => api.enter(value.trim()));
  const enterLocal = () => enterBy(() => api.enterLocal());

  // ローカルの起動なら、開いたときにトークンなしで入る（本番では localEntry が来ない）
  useEffect(() => {
    if (!localEntry || localAutoEntered) return;
    localAutoEntered = true;
    void enterLocal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localEntry]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void enterWith(token);
  };

  return (
    <main className="center">
      <h1>AgentTeam</h1>
      <p className="muted">頼むだけで、あなたの担当が生まれる</p>
      {localEntry && (
        <button type="button" className="btn btn-primary" onClick={() => void enterLocal()} disabled={busy}>
          {busy ? "入っています…" : "トークンなしで入る（ローカル）"}
        </button>
      )}
      <form onSubmit={submit} className="entry">
        <label htmlFor="token">入口のトークン</label>
        <input id="token" type="password" autoComplete="current-password" value={token} onChange={(e) => setToken(e.target.value)} autoFocus aria-describedby="token-note" />
        <p id="token-note" className="muted small">
          {JUDGE_TOKEN_NOTE}
        </p>
        <button type="submit" className="btn btn-primary" disabled={busy || token.trim().length === 0}>
          {busy ? "入っています…" : "入る"}
        </button>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>
    </main>
  );
}

function Shell({ onSignedOut }: { onSignedOut: () => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch(() => setFailed(true));
  }, []);

  if (failed) {
    return (
      <main className="center">
        <p>読み込めませんでした。</p>
        <button type="button" className="btn btn-primary" onClick={() => location.reload()}>
          もう一度開く
        </button>
      </main>
    );
  }
  if (!me) return <Loading />;
  return (
    <WorkspaceProvider me={me} onSignedOut={onSignedOut}>
      <Screens />
    </WorkspaceProvider>
  );
}

/** 画面の区別（クエリ ?item= や ?seq= の変化では動かさない） */
function screenKeyOf(route: Route): string {
  if (route.name === "ask") return `ask:${route.askId}`;
  if (route.name === "pack") return `pack:${route.packId}`;
  return route.name;
}

function Screens() {
  const route = useRoute();
  const { counts, online, killSwitchEngaged } = useWorkspace();
  const titleOverride = useScreenTitleOverride();
  useViewportHeight();
  // 全画面共通の「頼む」シート（<main key> の外に持つので、画面を移っても生成は続く）
  const [askSheetOpen, setAskSheetOpen] = useState(false);
  const openAskSheet = useCallback(() => setAskSheetOpen(true), []);
  const closeAskSheet = useCallback(() => setAskSheetOpen(false), []);
  const gen = useAskGeneration();
  useSlashToAsk(openAskSheet);
  const mainRef = useRef<HTMLElement>(null);
  const screenKey = screenKeyOf(route);
  const firstScreen = useRef(true);

  // タブの題：「(3) 依頼の文 · AgentTeam」。件数は、裏のタブからでも戻る理由が分かるように
  useEffect(() => {
    document.title = composeTitle(titleOf(route), { override: titleOverride, attention: counts?.attention ?? 0 });
  }, [route, titleOverride, counts?.attention]);

  // 戻る・進むで来たときは、離れたときの位置へ（中身が読み込まれて高さが足りるのを待ってから）
  useLayoutEffect(() => {
    const y = takePendingScroll();
    if (y === null || y === 0) return;
    return restoreWhenTall(y, {
      scrollTo: (v) => window.scrollTo(0, v),
      maxScroll: () => document.documentElement.scrollHeight - window.innerHeight,
      observe: (fn) => {
        const ro = new ResizeObserver(fn);
        ro.observe(document.body);
        return () => ro.disconnect();
      },
      now: () => performance.now(),
    });
  }, [screenKey]);

  // 画面を移ったらシートは閉じる（生成は続く）
  useEffect(() => setAskSheetOpen(false), [screenKey]);

  // 編成ができたら、少し見せて依頼のページへ移る。作れなかった・質問が来たときは、閉じていてもシートを開く
  const { phase, askId } = gen.state;
  const { reset } = gen;
  useEffect(() => {
    if (phase !== "shown" || !askId) return;
    const id = setTimeout(() => {
      navigate(`/asks/${askId}`);
      reset();
    }, ENTER_ASK_MS);
    return () => clearTimeout(id);
  }, [phase, askId, reset]);
  useEffect(() => {
    if (phase === "failed" || phase === "question") setAskSheetOpen(true);
  }, [phase]);

  // 画面を移ったら main にフォーカスを移す（スクリーンリーダーに移ったことを伝える）。最初の描画では動かさない
  useEffect(() => {
    if (firstScreen.current) {
      firstScreen.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
  }, [screenKey]);

  return (
    <div className="app">
      <AppHeader back={backOf(route)} />
      <main className="screen" ref={mainRef} tabIndex={-1}>
        {/* 画面が変わるたびに作り直して、中身をふわっと出す（フォーカスは main に残る） */}
        <div key={screenKey} className="screen-enter">
          {route.name === "home" && <Entrance />}
          {route.name === "check" && <Check />}
          {route.name === "done" && <Done />}
          {route.name === "audit" && <Audit seq={route.seq} />}
          {route.name === "ask" && <AskPage key={route.askId} askId={route.askId} />}
          {route.name === "agents" && <Agents />}
          {route.name === "asks" && <Asks q={route.q} status={route.status} />}
          {route.name === "packs" && <Packs q={route.q} category={route.category} />}
          {route.name === "pack" && <PackDetail packId={route.packId} />}
          {route.name === "notFound" && <NotFound />}
        </div>
      </main>
      {route.name !== "home" && (
        <button type="button" className="ask-fab" onClick={openAskSheet} aria-haspopup="dialog" aria-keyshortcuts="/">
          <span aria-hidden="true">＋</span> 頼む
        </button>
      )}
      {askSheetOpen && (
        <AskComposerSheet gen={gen} onAskPage={route.name === "ask"} disabled={!online || killSwitchEngaged} onClose={closeAskSheet} />
      )}
      <Notices />
    </div>
  );
}

/**
 * 「/」でどの画面からでも頼む入力欄へ（入口では #ask-input、それ以外の画面では「頼む」シート）。入力中・修飾キーつき・シートやメニューが開いている間は動かさない。
 * 画面を移ったときの main へのフォーカス（上の effect）より後に入れるため、入口へ移ったときは次の描画を待つ
 */
function useSlashToAsk(openSheet: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || e.isComposing || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      const input = document.getElementById("ask-input");
      if (input) return input.focus();
      // 入口で生成中など、入力欄が出ていないときは何もしない。入口以外の画面ではシートを開く
      if (location.pathname !== "/") openSheet();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openSheet]);
}

function NotFound() {
  return (
    <div className="notfound">
      <h1>ページが見つかりません</h1>
      <p className="muted">アドレスが違うか、ページが移ったようです。</p>
      <Link to="/" className="btn btn-ghost">
        任せるへ戻る
      </Link>
    </div>
  );
}

installHistory();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
