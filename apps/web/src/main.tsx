import { StrictMode, useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { api, onUnauthorized, type Me, type SessionState } from "./api";
import { AppHeader, Sidebar, useWide } from "./components/AppHeader";
import { Notices } from "./components/Notices";
import { installHistory, Link, navigate, takePendingScroll, useRoute, type Route } from "./lib/router";
import { restoreWhenTall } from "./lib/scrollMemory";
import { backOf, titleOf } from "./lib/screen";
import { composeTitle, useScreenTitleOverride } from "./lib/title";
import { useViewportHeight } from "./lib/viewport";
import { Agents } from "./screens/Agents";
import { Asks } from "./screens/Asks";
import { PackDetail, Packs } from "./screens/Packs";
import { AskPage } from "./screens/AskPage";
import { Audit } from "./screens/Audit";
import { Check } from "./screens/Check";
import { Done } from "./screens/Done";
import { Chat } from "./screens/Chat";
import { useWorkspace, WorkspaceProvider } from "./workspace";
import "./styles.css";
import "./styles/shell.css";
import "./styles/entrance.css";
import "./styles/chat.css";
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

// unreachable：GET /session が失敗した（app や DB が止まっている）。トークンの入口だけを出すと、ローカルでも入れないように見える
type Session = { state: "loading" } | { state: "unreachable" } | SessionState;

function App() {
  const [session, setSession] = useState<Session>({ state: "loading" });

  const refresh = useCallback(() => {
    return api
      .session()
      .then(setSession)
      .catch(() => setSession({ state: "unreachable" }));
  }, []);

  useEffect(() => {
    void refresh();
    // 401 のあとも GET /session から入り直す（ローカルならトークンなしの入口が出る）
    return onUnauthorized(() => void refresh());
  }, [refresh]);

  switch (session.state) {
    case "loading":
      return <Loading />;
    case "unreachable":
      return <Unreachable onRetry={refresh} />;
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

function Unreachable({ onRetry }: { onRetry: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const retry = () => {
    setBusy(true);
    void onRetry().finally(() => setBusy(false));
  };
  return (
    <main className="center">
      <h1>AgentTeam</h1>
      <p role="alert">サーバーにつながりません。</p>
      <p className="muted">ローカルなら app（pnpm dev）と DB（docker compose up -d db）が起動しているか確かめてください。</p>
      <button type="button" className="btn btn-primary" onClick={retry} disabled={busy}>
        {busy ? "確かめています…" : "もう一度試す"}
      </button>
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

  const enterBy = async (call: () => ReturnType<typeof api.enter>, local = false) => {
    setBusy(true);
    setError(null);
    try {
      const res = await call();
      // 入口（SCR-020）へ
      if (res.next && res.next !== "/") navigate(res.next, { replace: true });
      await onSignedIn();
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 401) setError("トークンが違います");
      else if (local && status === 403) setError("トークンなしで入れるのはこのマシンからだけです");
      else if (local) setError("トークンなしで入れませんでした。DB（docker compose up -d db）が起動しているか確かめてください");
      else setError("入れませんでした。時間をおいて試してください");
    } finally {
      // 入れた直後の GET /session が失敗しても「入る」を押せるままにする（成功なら入口ごと消える）
      setBusy(false);
    }
  };
  const enterWith = (value: string) => enterBy(() => api.enter(value.trim()));
  const enterLocal = () => enterBy(() => api.enterLocal(), true);

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
      <p className="muted">あなただけの、エージェント。</p>
      {localEntry && (
        <button type="button" className="btn btn-primary" onClick={() => void enterLocal()} disabled={busy}>
          {busy ? "入っています…" : "トークンなしで入る（ローカル）"}
        </button>
      )}
      <form onSubmit={submit} className="entry">
        <label htmlFor="token">入口のトークン</label>
        <input id="token" type="password" autoComplete="current-password" value={token} onChange={(e) => setToken(e.target.value)} autoFocus />
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
  const { counts } = useWorkspace();
  const titleOverride = useScreenTitleOverride();
  useViewportHeight();
  const wide = useWide();
  useSlashToChat();
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
      {wide && <Sidebar />}
      <AppHeader back={backOf(route)} />
      <main className="screen" ref={mainRef} tabIndex={-1}>
        {/* 画面が変わるたびに作り直して、中身をふわっと出す（フォーカスは main に残る） */}
        <div key={screenKey} className="screen-enter">
          {route.name === "home" && <Chat />}
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
      <Notices />
    </div>
  );
}

/** 「/」でどの画面からでもチャットの入力欄へ（ほかの画面ならチャットへ移ってから）。入力中・修飾キーつき・シートやメニューが開いている間は動かさない */
function useSlashToChat() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || e.isComposing || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      const input = document.getElementById("ask-input");
      if (input) return input.focus();
      // 画面を移ったときの main へのフォーカスより後に入れるため、次の描画を待つ
      if (location.pathname !== "/") {
        navigate("/");
        setTimeout(() => document.getElementById("ask-input")?.focus(), 50);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function NotFound() {
  return (
    <div className="notfound">
      <h1>ページが見つかりません</h1>
      <p className="muted">アドレスが違うか、ページが移ったようです。</p>
      <Link to="/" className="btn btn-ghost">
        チャットへ戻る
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
