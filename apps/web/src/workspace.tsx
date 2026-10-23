// ログイン後の共通の状態：ワークスペース・件数・オンライン・SSE の事象の配り
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, subscribeWorkspace, type CheckCounts, type Me, type WorkspaceView } from "./api";

type Listener = (type: string, data: unknown) => void;

interface WorkspaceContextValue {
  me: Me;
  workspace: WorkspaceView;
  online: boolean;
  counts: CheckCounts | null;
  refreshCounts: () => void;
  /** SSE の事象を受ける。戻り値で外す */
  subscribe: (fn: Listener) => () => void;
  signOut: () => Promise<void>;
  /** Google カレンダーの接続（切断したら書き換える。入口の案内とメニューが同じ値を見る） */
  google: WorkspaceView["google"];
  setGoogle: (google: WorkspaceView["google"]) => void;
  /** GitHub の接続（切断・許可の切り替えで書き換える） */
  github: WorkspaceView["github"];
  setGithub: (github: WorkspaceView["github"]) => void;
}

const Ctx = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace(): WorkspaceContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("WorkspaceProvider の外です");
  return v;
}

/** 事象のたびに handler を呼ぶ（最新の handler が使われる） */
export function useWorkspaceEvent(handler: Listener): void {
  const { subscribe } = useWorkspace();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribe((t, d) => ref.current(t, d)), [subscribe]);
}

export function WorkspaceProvider({ me, onSignedOut, children }: { me: Me; onSignedOut: () => void; children: ReactNode }) {
  const workspaceId = me.workspace.id;
  const [counts, setCounts] = useState<CheckCounts | null>(null);
  const [browserOnline, setBrowserOnline] = useState(() => navigator.onLine);
  const [streamDown, setStreamDown] = useState(false);
  const listeners = useRef(new Set<Listener>());
  const [google, setGoogle] = useState(me.workspace.google);
  useEffect(() => setGoogle(me.workspace.google), [me]);
  const [github, setGithub] = useState(me.workspace.github);
  useEffect(() => setGithub(me.workspace.github), [me]);

  const refreshCounts = useCallback(() => {
    api
      .counts()
      .then(setCounts)
      .catch(() => undefined);
  }, []);

  const subscribe = useCallback((fn: Listener) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  useEffect(() => {
    const on = () => setBrowserOnline(true);
    const off = () => setBrowserOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  useEffect(() => {
    refreshCounts();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let opened = false;
    const close = subscribeWorkspace(workspaceId, {
      onOpen: () => {
        setStreamDown(false);
        refreshCounts();
        // つなぎ直しのあとは、切れていた間の事象を取りこぼしているかもしれない。画面は reset で REST から取り直す
        if (opened) listeners.current.forEach((fn) => fn("reset", {}));
        opened = true;
      },
      // 切れてすぐではなく、猶予（8 秒）の間につながらなかったとき（ブラウザの自動のつなぎ直し中は出さない）
      onDown: () => setStreamDown(true),
      onEvent: (type, data) => {
        if (type === "check.counts" && data && typeof data === "object") {
          // 件数そのものが届いたので、取り直さない
          setCounts(data as CheckCounts);
          listeners.current.forEach((fn) => fn(type, data));
          return;
        }
        listeners.current.forEach((fn) => fn(type, data));
        clearTimeout(timer);
        timer = setTimeout(refreshCounts, 300);
      },
    });
    return () => {
      clearTimeout(timer);
      close();
    };
  }, [workspaceId, refreshCounts]);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => undefined);
    onSignedOut();
  }, [onSignedOut]);

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      me,
      workspace: me.workspace,
      online: browserOnline && !streamDown,
      counts,
      refreshCounts,
      subscribe,
      signOut,
      google,
      setGoogle,
      github,
      setGithub,
    }),
    [me, browserOnline, streamDown, counts, refreshCounts, subscribe, signOut, google, github],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
