// SCR-014：担当（`/agents`）。頼むと生まれた担当のライブラリ。名前・役割・いまの様子・関わった依頼・仕事を、最後に動いた順に並べる
import { useCallback, useEffect, useRef, useState } from "react";
import { api, describeError, type AgentLibraryItem, type AgentLibraryResponse } from "../api";
import { Avatar } from "../components/Avatar";
import { LoadError } from "../components/LoadError";
import { SkeletonCards } from "../components/Skeleton";
import { formatTime } from "../lib/format";
import { Link, useLocationHash } from "../lib/router";
import { useWorkspaceEvent } from "../workspace";
import type { AvatarMood } from "../lib/avatar";
import { ASK_STATUS_TEXT } from "../lib/askList";
import { Chevron } from "../ui/icons";
import { AgentSkills, restorableCount } from "../components/AgentSkills";

/** いまの様子 → 表情 */
export function moodOfActivity(activity: AgentLibraryItem["activity"]): AvatarMood {
  switch (activity) {
    case "running":
      return "running";
    case "awaiting_approval":
      return "approval";
    case "disabled":
      return "stopped";
    default:
      return "idle";
  }
}

/** 「依頼 3件 · 仕事 2件 · 最後に動いた 10/8 18:02」（まだ動いていなければ「生まれた …」） */
export function metaLineOf(a: Pick<AgentLibraryItem, "askCount" | "jobCount" | "lastActiveAt" | "createdAt">, now: Date = new Date()): string {
  const parts = [`依頼 ${a.askCount}件`, `仕事 ${a.jobCount}件`];
  parts.push(a.lastActiveAt ? `最後に動いた ${formatTime(a.lastActiveAt, now)}` : `生まれた ${formatTime(a.createdAt, now)}`);
  return parts.join(" · ");
}

export function Agents() {
  const [data, setData] = useState<AgentLibraryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const my = ++seq.current;
    try {
      const r = await api.agents();
      if (my !== seq.current) return;
      setData(r);
      setError(null);
    } catch (e) {
      if (my !== seq.current) return;
      setError(describeError(e));
    }
  }, []);

  useEffect(() => {
    void load();
    return () => clearTimeout(timer.current);
  }, [load]);

  // 編成ができた・担当が動いた・終わったら取り直す（事象は取りこぼしてもよい。まとめて 400ms 後に1回）
  useWorkspaceEvent((type) => {
    if (type === "reset") return void load();
    // スキルの案が届いた・整理で外した・戻した
    if (!type.startsWith("ask.") && type !== "agent.skill_proposed" && !type.startsWith("agent.evolution.")) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(), 400);
  });

  if (error && !data)
    return (
      <div className="agents-page">
        <h1 className="ask-head">エージェント</h1>
        <LoadError message={error} onRetry={load} />
      </div>
    );
  if (!data) return <SkeletonCards count={3} head />;

  return (
    <div className="agents-page">
      <h1 className="ask-head">
        エージェント
        {data.count > 0 && (
          <span className="ask-count" aria-label={`${data.count}体`}>
            {data.count}
          </span>
        )}
      </h1>
      <p className="muted agents-lead">
        頼むと生まれたエージェントです。似た依頼は同じエージェントが引き受け、許可したルールを引き継ぎます。<Link to="/packs">パック</Link>からまとめて入れることもできます。
      </p>
      {error && (
        <p className="error small" role="status">
          {error}
        </p>
      )}
      {data.items.length === 0 ? (
        <div className="done-empty">
          <p className="muted">まだエージェントはいません。入口で頼むと生まれます</p>
          <Link to="/" className="btn">
            入口へ
          </Link>
        </div>
      ) : (
        <ul className="rows agents-list" aria-label="エージェント">
          {data.items.map((a) => (
            <AgentCard key={a.id} agent={a} onChanged={load} />
          ))}
        </ul>
      )}
      {data.count >= data.limit && <p className="muted small agents-limit">エージェントは {data.limit} 人までです。これ以上は新しく作れません</p>}
    </div>
  );
}

function AgentCard({ agent: a, onChanged }: { agent: AgentLibraryItem; onChanged: () => void }) {
  // /agents#<agentId> で開いたら、この担当のカードを開き、見える位置まで動かして目立たせる
  const hash = useLocationHash();
  const targeted = hash === `#${a.id}`;
  const [open, setOpen] = useState(targeted);
  const li = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (!targeted) return;
    setOpen(true);
    li.current?.scrollIntoView({ block: "start" });
  }, [targeted]);
  const panelId = `agent-${a.id}`;
  const proposalCount = a.skillProposals?.length ?? 0;
  const restorable = restorableCount(a);
  return (
    <li ref={li} id={a.id} className={`row agent is-${a.activity}${targeted ? " is-target" : ""}`}>
      <button type="button" className="agent-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((v) => !v)}>
        <Avatar name={a.name} mood={moodOfActivity(a.activity)} size={52} className="agent-avatar" />
        <span className="agent-main">
          <span className="agent-head">
            <span className="agent-name">{a.name}</span>
            {a.roleLabel && <span className="agent-role">{a.roleLabel}</span>}
            <span className={`stage-state is-${a.activity === "awaiting_approval" ? "awaiting" : a.activity}`}>{a.activityText}</span>
          </span>
          <span className="row-meta">{metaLineOf(a)}</span>
          {a.growthLine && <span className="row-meta">{a.growthLine}</span>}
          {proposalCount > 0 && <span className="row-meta agent-skill-note">スキルの案が {proposalCount}件 届いています</span>}
          {restorable > 0 && <span className="row-meta">使われていないものを {restorable}件 外しました</span>}
          {a.disabledReason && <span className="row-meta">止めた理由：{a.disabledReason}</span>}
        </span>
        <span className="agent-chevron">
          <Chevron open={open} />
        </span>
      </button>
      {open && (
        <div id={panelId} className="agent-detail">
          <section>
            <h2 className="agent-sub">関わった依頼</h2>
            {a.asks.length === 0 ? (
              <p className="muted small">まだ依頼に関わっていません</p>
            ) : (
              <ul className="plain agent-asks">
                {a.asks.map((k) => (
                  <li key={k.askId}>
                    <Link to={`/asks/${k.askId}`} className="agent-ask">
                      <span className="agent-ask-text">{k.text}</span>
                      <span className="agent-ask-summary">{k.summary}</span>
                      <span className="muted small">
                        {[k.askId === a.bornAskId ? "ここで生まれた" : null, k.isSpokesperson ? "窓口" : null, k.isAggregator ? "まとめ役" : null, ASK_STATUS_TEXT[k.status], formatTime(k.createdAt)]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </Link>
                  </li>
                ))}
                {a.askCount > a.asks.length && <li className="muted small">ほか {a.askCount - a.asks.length} 件</li>}
              </ul>
            )}
          </section>
          {a.jobs.length > 0 && (
            <section>
              <h2 className="agent-sub">仕事</h2>
              <ul className="agent-jobs">
                {a.jobs.map((j) => (
                  <li key={j.jobId} className="agent-job">
                    {j.templateLabel} · {j.kindLabel}
                    {j.status === "paused" ? " · 一時停止" : j.status === "done" ? " · 済み" : ""}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <AgentSkills agent={a} onChanged={onChanged} />
          {usesWorkspace(a) && <WorkspaceReset agent={a} />}
          <p className="muted small">
            {a.nameSource === "suggested" ? "名前はエージェントを作るときに付けました" : "名前は自分で付けました"} · 作成 {formatTime(a.createdAt)}
          </p>
        </div>
      )}
    </li>
  );
}

/** 作業場（コードを書いて動かす場所）を使う担当か：「作る」（dev-coder）・「見直す」（reviewer）の仕事がある */
export function usesWorkspace(a: Pick<AgentLibraryItem, "jobs">): boolean {
  return a.jobs.some((j) => j.template === "dev-coder" || j.template === "reviewer");
}

/**
 * 「作業場を最初に戻す」（SG-07）。外から来た内容を読んだあとの作業場のファイルが残ると、この担当はテストを確認なしに動かせなくなる。
 * 押すと確かめてから、パックのファイル（パックの担当）か空に戻す。作業場が動いている間はできない（409）
 */
function WorkspaceReset({ agent: a }: { agent: AgentLibraryItem }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reset = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    api
      .resetAgentWorkspace(a.id)
      .then(() => {
        setDone(true);
        setConfirming(false);
      })
      .catch((e: unknown) => setError(describeError(e)))
      .finally(() => setBusy(false));
  };
  return (
    <section>
      <h2 className="agent-sub">作業場</h2>
      {done ? (
        <p className="small" role="status">
          作業場を最初に戻しました
        </p>
      ) : confirming ? (
        <div className="inline-form">
          <p className="row-title">作業場を最初に戻しますか？</p>
          <p className="muted small">
            このエージェントが作業場に残したファイルは、次の仕事から使われなくなります（パックから入れたエージェントはパックのファイル、それ以外は空から始めます）。
          </p>
          <div className="inline-actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={reset}>
              {busy ? "戻しています…" : "最初に戻す"}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setConfirming(false)}>
              やめる
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn" onClick={() => setConfirming(true)}>
          作業場を最初に戻す
        </button>
      )}
      {error && (
        <p className="small" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
