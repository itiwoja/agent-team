// パックの作業場（`/packs/:packId`。D-116）：そのパックの部屋で、担当（エージェント）が机に座って働いている場面。
// 担当は待機中、持ち物（スキル・スクリプト）や例の依頼を見ながら数秒おきに独り言をこぼし（自分で考えて動いている見た目）、
// 下の入力欄から頼むと、返事を待たずにその場で全員が反応して動き出す。依頼の生成（ask.*）は入口と同じ畳み込み（lib/generation.ts）で追い、
// 編成に入った担当の机が光る。入れていないときは机が薄く、[入れる] で入れるとセレモニーのあとに部屋に灯りがつく
import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { api, describeError, type AgentAskView, type AgentLibraryItem, type FormationView, type PackAgentView, type PackView } from "../api";
import { Avatar } from "../components/Avatar";
import { askNoticePermission } from "../components/Notices";
import { PackInstallCeremony, type CeremonyAgent } from "../components/PackInstallCeremony";
import { ASK_STATUS_TEXT } from "../lib/askList";
import { formatTime } from "../lib/format";
import { GIVE_UP_MS, SLOW_MS, askCreatedAfterGiveUp, generationReducer, initialGen, isGenerationEvent, type GenState } from "../lib/generation";
import { MUSING_MS, canMuse, clip, deskStateOf, matchMembers, musingAt, musingsOf, pickSpeakers, reactionOf, type DeskState, type Helper } from "../lib/packWorkspace";
import { Link, navigate } from "../lib/router";
import { ArrowUpIcon } from "../ui/icons";
import { useWorkspace, useWorkspaceEvent } from "../workspace";
import { TEMPLATE_LABEL } from "../lib/packLabels";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const SCRIPT_RE = /\.(py|js|mjs|ts|sh)$/;

/** 動きを減らす設定か（設定が変わったら追う。読めない環境では減らさない） */
function useReducedMotion(): boolean {
  const query = () => {
    try {
      return typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION).matches;
    } catch {
      return false;
    }
  };
  const [reduced, setReduced] = useState(query);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(REDUCED_MOTION);
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

/** 独り言の交代の拍（MUSING_MS ごとに 1 進む。裏のタブ・動きを減らす設定・話す担当がいないときは止める） */
function useMusingTick(active: boolean, reduced: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active || reduced) return;
    const id = setInterval(() => {
      if (!document.hidden) setTick((t) => t + 1);
    }, MUSING_MS);
    return () => clearInterval(id);
  }, [active, reduced]);
  return tick;
}

/** ライブラリの担当（いまの様子）。入れてあるときだけ読み、依頼が動いたら 400ms でまとめて取り直す（エージェントの画面と同じ） */
function useLibrary(enabled: boolean): AgentLibraryItem[] | null {
  const [items, setItems] = useState<AgentLibraryItem[] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const my = ++seq.current;
    try {
      const r = await api.agents();
      if (my === seq.current) setItems(r.items);
    } catch {
      // 読めなくても机は出せる（様子が分からない担当は待機中として扱う）
    }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    void load();
    return () => clearTimeout(timer.current);
  }, [enabled, load]);
  useWorkspaceEvent((type) => {
    if (!enabled) return;
    if (type === "reset") return void load();
    if (!type.startsWith("ask.")) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(), 400);
  });
  return items;
}

/** 関わった依頼の最新 1 件 */
function latestAsk(item: AgentLibraryItem | undefined): AgentAskView | null {
  if (!item || item.asks.length === 0) return null;
  return [...item.asks].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

/** 動いている・確認待ちの吹き出しに添える依頼の文（いま動いている依頼があればそれ） */
function activeAskText(item: AgentLibraryItem | undefined): string | null {
  if (!item) return null;
  const active = [...item.asks].filter((k) => k.status === "running" || k.status === "waiting_input").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return active?.text ?? null;
}

const live = (s: GenState) => s.phase === "generating" || s.phase === "question";

export function PackWorkspace({ pack: p, onInstalled }: { pack: PackView; onInstalled: (p: PackView) => void }) {
  const { killSwitchEngaged, online } = useWorkspace();
  const installed = p.installedAt !== null;
  const reduced = useReducedMotion();
  const roomId = useId();
  const askHeadId = useId();
  const roomHeadRef = useRef<HTMLHeadingElement>(null);

  // --- 入れる（成功 → セレモニー → 閉じたら灯りのついた作業場） ---
  const [busy, setBusy] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [ceremony, setCeremony] = useState<CeremonyAgent[] | null>(null);
  const [justInstalled, setJustInstalled] = useState<string[] | null>(null);
  const install = () => {
    if (busy) return;
    setBusy(true);
    setInstallError(null);
    api
      .installPack(p.id)
      .then((r) => {
        onInstalled(r.pack);
        setJustInstalled(r.agents.map((a) => a.name));
        setCeremony(r.pack.agents.map(({ name, summary, template, skills, files }) => ({ name, summary, template, skills, files })));
      })
      .catch((e: unknown) => setInstallError(describeError(e)))
      .finally(() => setBusy(false));
  };
  const closeCeremony = useCallback(() => {
    setCeremony(null);
    // 押した [入れる] は消えているので、部屋の見出しにフォーカスを移す（セレモニーのフォーカスの戻しより後に）
    requestAnimationFrame(() => roomHeadRef.current?.focus());
  }, []);

  // --- 担当の様子 ---
  const library = useLibrary(installed);
  const libraryOf = useCallback(
    (a: PackAgentView): AgentLibraryItem | undefined => {
      if (!library) return undefined;
      if (a.agentId !== null) return library.find((x) => x.id === a.agentId);
      return library.find((x) => x.name === a.name);
    },
    [library],
  );

  // --- 頼む（入口と同じ畳み込み） ---
  const [state, dispatch] = useReducer(generationReducer, initialGen);
  const [text, setText] = useState("");
  const [round, setRound] = useState(0);
  // 編成の担当の agentId は畳み込みの members に無いので、ask.formed（と引き直し）の編成をここで覚えておく
  const [formations, setFormations] = useState<Record<string, FormationView>>({});
  const phaseRef = useRef(state.phase);
  phaseRef.current = state.phase;
  const askIdRef = useRef(state.askId);
  askIdRef.current = state.askId;
  const generationRef = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);

  useWorkspaceEvent((type, data) => {
    if (!data || typeof data !== "object") return;
    const event = { ...(data as Record<string, unknown>), type };
    if (!isGenerationEvent(event)) return;
    if (event.type === "ask.formed" && (phaseRef.current === "generating" || phaseRef.current === "question")) {
      const { askId, formation } = event;
      setFormations((f) => ({ ...f, [askId]: formation }));
    }
    dispatch({ type: "event", event });
  });

  // 10 秒で「まだ考えています」、30 秒で打ち切り（作られていれば依頼のページへ）
  useEffect(() => {
    if (state.phase !== "generating") return;
    let cancelled = false;
    const generation = generationRef.current;
    const askId = state.askId;
    const slow = setTimeout(() => dispatch({ type: "slow" }), SLOW_MS);
    const giveUp = setTimeout(() => {
      void askCreatedAfterGiveUp(askId, (id) => api.ask(id)).then((id) => {
        if (cancelled || generationRef.current !== generation || askIdRef.current !== askId) return;
        const ph = phaseRef.current;
        if (id !== null && (ph === "generating" || ph === "question")) navigate(`/asks/${id}`);
        else dispatch({ type: "timeout" });
      });
    }, GIVE_UP_MS);
    return () => {
      clearTimeout(slow);
      clearTimeout(giveUp);
      cancelled = true;
    };
  }, [state.phase, state.askId]);

  // 事象を取りこぼしても追いつく（4 秒ごとに依頼を引き直す）
  useEffect(() => {
    if ((state.phase !== "generating" && state.phase !== "question") || !state.askId) return;
    const askId = state.askId;
    const id = setInterval(() => {
      api
        .ask(askId)
        .then((detail) => {
          const formation = detail.formation;
          if (formation) setFormations((f) => ({ ...f, [askId]: formation }));
          dispatch({ type: "detail", detail });
        })
        .catch(() => undefined);
    }, 4000);
    return () => clearInterval(id);
  }, [state.phase, state.askId]);

  // 編成ができたら、進みの欄（人数・依頼のページを開く）を見える所へ（狭い画面では応援の机が増えて下に押し出される）
  useEffect(() => {
    if (state.phase === "shown") liveRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [state.phase]);

  // 作れなかったら、送った文を入力欄に戻す（表情は畳み込みが failed になった時点でいつもの様子に戻る）
  useEffect(() => {
    if (state.phase === "failed") setText(state.sentText);
  }, [state.phase, state.sentText]);

  const submit = useCallback(
    async (value: string) => {
      const t = value.trim();
      // 生成中・質問中は重ねて送らない
      if (!t || phaseRef.current === "generating" || phaseRef.current === "question") return;
      askNoticePermission();
      generationRef.current += 1;
      // 返事を待たずに、ここで全員が反応する（submit で phase が generating になり、机が running になる）
      setRound((r) => r + 1);
      setText("");
      dispatch({ type: "submit", text: t });
      // 送るボタンは止まり、例のチップは消えるので、フォーカスを入力欄に置いておく（body に落とさない）
      inputRef.current?.focus();
      try {
        const { ask } = await api.createAsk(t, undefined, { packId: p.id });
        dispatch({ type: "accepted", ask });
      } catch (e) {
        dispatch({ type: "error", message: describeError(e) });
      }
    },
    [p.id],
  );

  const answer = useCallback(
    async (a: { choiceId: string } | { text: string }) => {
      if (!state.askId) return;
      dispatch({ type: "answered" });
      try {
        await api.answerAsk(state.askId, a);
      } catch (e) {
        dispatch({ type: "error", message: describeError(e) });
      }
    },
    [state.askId],
  );

  // 編成を見せたあとの [閉じる]（押したボタンは消えるので、フォーカスは入力欄へ）
  const closeProgress = useCallback(() => {
    dispatch({ type: "reset" });
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  // --- 編成：机に当たる担当と応援 ---
  const { joined, helpers } = useMemo(() => {
    if (state.phase !== "shown") return { joined: {} as Record<string, string>, helpers: [] as Helper[] };
    const formation = state.askId ? formations[state.askId] : undefined;
    const members = state.members.map((m) => ({ ...m, agentId: formation?.members.find((x) => x.memberId === m.key)?.agentId ?? null }));
    return matchMembers(members, p.agents);
  }, [state.phase, state.askId, state.members, formations, p.agents]);

  // --- 机の表示 ---
  const musings = useMemo(() => new Map(p.agents.map((a) => [a.name, musingsOf(a, p.examples)])), [p.agents, p.examples]);
  const base = p.agents.map((a) => {
    const item = libraryOf(a);
    return { agent: a, item, activity: item?.activity ?? null, joined: Object.hasOwn(joined, a.name) };
  });
  const museNames = base.filter((d) => canMuse({ installed, activity: d.activity, phase: state.phase, joined: d.joined })).map((d) => d.agent.name);
  const tick = useMusingTick(museNames.length > 0, reduced);
  // 動きを減らす設定では、ひとりだけが静かな 1 文を話し、交代しない
  const speakers = new Set(pickSpeakers(museNames, tick, reduced ? 1 : 2));
  const desks = base.map((d, i) => ({
    ...d,
    state: deskStateOf({
      installed,
      activity: d.activity,
      askText: activeAskText(d.item),
      phase: state.phase,
      joined: d.joined,
      reaction: reactionOf(d.agent.template, round * 7 + i),
      musing: speakers.has(d.agent.name) ? musingAt(musings.get(d.agent.name) ?? [], d.agent.name, tick) : null,
    }),
  }));
  const working = desks.filter((d) => d.state.mood === "running" || d.state.mood === "approval").length;

  // 生成中も入力欄は触れる（フォーカスを失わない）。送るのだけ止める
  const inputDisabled = killSwitchEngaged || !online;
  const placeholder = p.examples[0] ? `例：${p.examples[0]}` : "この作業場に頼みたいこと";

  return (
    <div className="pw">
      <header className="pw-head">
        <div className="pw-head-main">
          <p className="pw-kicker">
            {p.audience}向け{p.category && <> · {p.category}</>}
          </p>
          <h1 className="pw-name">{p.name}</h1>
          <p className="pw-tagline">{p.tagline}</p>
        </div>
        {installed ? (
          <span className="pack-installed">入っています</span>
        ) : (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={install}>
            {busy ? "入れています…" : "入れる"}
          </button>
        )}
      </header>
      <p className="muted pw-description">{p.description}</p>
      {installError && (
        <p className="error" role="alert">
          {installError}
        </p>
      )}
      {justInstalled && !ceremony && (
        <p className="pw-done" role="status">
          {justInstalled.join("・")}が入りました。<Link to="/agents">エージェントを見る</Link>
        </p>
      )}

      <section className={`pw-room${installed ? "" : " is-vacant"}`} aria-labelledby={roomId} aria-busy={live(state) || undefined}>
        <div className="pw-room-head">
          <h2 id={roomId} ref={roomHeadRef} tabIndex={-1} className="pw-room-title">
            {installed ? "作業場" : "作業場（まだ空いています）"}
          </h2>
          <span className="pw-room-meta">
            {p.agents.length}人{installed && (working > 0 ? ` · ${working}人が動いています` : " · 待機中")}
          </span>
        </div>
        <ul className="plain pw-desks" aria-label="担当の机">
          {desks.map((d, i) => (
            <Desk key={d.agent.name} agent={d.agent} state={d.state} installed={installed} joinedSummary={Object.hasOwn(joined, d.agent.name) ? (joined[d.agent.name] ?? null) : null} latest={latestAsk(d.item)} index={i} />
          ))}
          {helpers.map((h, i) => (
            <HelperDesk key={h.key} helper={h} index={i} />
          ))}
        </ul>
        {!installed && <p className="muted small pw-room-note">入れると、この部屋に担当がそろって働きはじめます。</p>}
      </section>

      {p.needsSandbox && !p.sandboxAvailable && (
        <p className="muted small pack-note">「作る」「見直す」担当が使う作業場（コードを書いて動かす場所）は、この環境ではまだ使えません。入れることはでき、作業場なしでできる範囲で動きます。</p>
      )}

      {installed ? (
        <section className="pw-ask" aria-labelledby={askHeadId}>
          <h2 id={askHeadId} className="pw-section">
            この作業場に頼む
          </h2>
          <Progress state={state} joinedCount={Object.keys(joined).length} helperCount={helpers.length} onAnswer={answer} onClose={closeProgress} liveRef={liveRef} />
          {state.phase === "failed" && (
            <p className="error" role="alert">
              {state.message}
            </p>
          )}
          {killSwitchEngaged ? <p className="muted small">全部止めているあいだは頼めません</p> : !online && <p className="muted small">つながっていません</p>}
          <Composer value={text} onChange={setText} onSubmit={(v) => void submit(v)} disabled={inputDisabled} sending={live(state)} placeholder={placeholder} inputRef={inputRef} />
          {!live(state) && p.examples.length > 0 && (
            <div className="pw-examples" role="group" aria-label="例の依頼">
              {p.examples.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  className="chip pw-example"
                  disabled={killSwitchEngaged}
                  onClick={() => {
                    setText(ex);
                    inputRef.current?.focus();
                  }}
                >
                  {ex}
                </button>
              ))}
            </div>
          )}
        </section>
      ) : (
        p.examples.length > 0 && (
          <section className="pw-ask" aria-labelledby={askHeadId}>
            <h2 id={askHeadId} className="pw-section">
              たとえばこんな依頼
            </h2>
            <ul className="plain pw-examples-static">
              {p.examples.map((e) => (
                <li key={e}>「{e}」</li>
              ))}
            </ul>
          </section>
        )
      )}

      {p.skills.length > 0 && (
        <details className="pw-shelf">
          <summary>
            <span className="pw-section">スキル（手順書）の棚</span>
            <span className="muted small">{p.skills.length}冊</span>
          </summary>
          <ul className="plain pw-shelf-list">
            {p.skills.map((s) => (
              <li key={s.name}>
                <span className="pw-skill-name">{s.name}</span>
                <span className="row-meta">{s.description}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {installed && p.installedAt && <p className="muted small">入れた日時：{formatTime(p.installedAt)}</p>}

      {ceremony && <PackInstallCeremony packName={p.name} agents={ceremony} onDone={closeCeremony} />}
    </div>
  );
}

/** 担当の机：吹き出し・アイコン・名前と型の札・すること・持ち物・関わった依頼 */
function Desk({
  agent: a,
  state,
  installed,
  joinedSummary,
  latest,
  index,
}: {
  agent: PackAgentView;
  state: DeskState;
  installed: boolean;
  joinedSummary: string | null;
  latest: AgentAskView | null;
  index: number;
}) {
  // 独り言と反応は飾り（読み上げない）。本当の状態（動いています等）と案内は文字として読ませる
  const decorative = state.kind === "ambient" || state.kind === "reaction";
  const files = [...a.files].sort((x, y) => Number(SCRIPT_RE.test(y)) - Number(SCRIPT_RE.test(x)));
  return (
    <li className={`pw-desk is-${state.kind}${state.glow ? " is-glow" : ""}`} style={{ ["--i" as string]: index }}>
      <div className="pw-bubble-slot">
        {state.bubble && (
          <p key={state.bubble} className={`pw-bubble is-${state.kind}`} aria-hidden={decorative || undefined}>
            <span className="pw-bubble-text">{state.bubble}</span>
          </p>
        )}
      </div>
      <div className="pw-seat" aria-hidden="true">
        <Avatar name={a.name} mood={state.mood} size={56} />
        <span className="pw-laptop">
          <span className="pw-laptop-lines" />
        </span>
      </div>
      <div className="pw-desk-body">
        <div className="pw-desk-head">
          <h3 className="pw-desk-name">{a.name}</h3>
          <span className="pack-chip">{TEMPLATE_LABEL[a.template] ?? a.template}</span>
        </div>
        {installed && (state.kind === "ambient" || state.kind === "none") && <span className="sr-only">待機中</span>}
        <p className="pw-desk-summary">{joinedSummary ?? a.summary}</p>
        {(a.skills.length > 0 || files.length > 0) && (
          <ul className="plain pw-kit" aria-label="持ち物">
            {a.skills.map((s) => (
              <li key={`s:${s}`} className="pw-kit-item is-skill">
                {s}
              </li>
            ))}
            {files.map((f) => (
              <li key={`f:${f}`} className="pw-kit-item is-file" title={f}>
                {f.split("/").pop()}
              </li>
            ))}
          </ul>
        )}
        {latest && (
          <Link to={`/asks/${latest.askId}`} className="pw-desk-ask">
            <span className="pw-desk-ask-text">{clip(latest.text, 28)}</span>
            <span className="muted"> · {ASK_STATUS_TEXT[latest.status]}</span>
          </Link>
        )}
      </div>
    </li>
  );
}

/** 応援（パックの外から編成に入った担当・新しく作った担当）。作業場の端にぽんと現れる */
function HelperDesk({ helper: h, index }: { helper: Helper; index: number }) {
  return (
    <li className="pw-desk is-helper is-glow" style={{ ["--i" as string]: index }}>
      <div className="pw-bubble-slot">
        <p className="pw-bubble is-joined">
          <span className="pw-bubble-text">{h.isNew ? "応援に来ました" : "手伝います"}</span>
        </p>
      </div>
      <div className="pw-seat" aria-hidden="true">
        <Avatar name={h.agentName} mood={h.isNew ? "done" : "running"} size={56} className="avatar-pop" />
      </div>
      <div className="pw-desk-body">
        <div className="pw-desk-head">
          <h3 className="pw-desk-name">応援：{h.agentName}</h3>
        </div>
        <p className="pw-desk-summary">{h.summary}</p>
        <p className="muted small">{h.isNew ? "新しく作りました" : "いつもの担当"}</p>
      </div>
    </li>
  );
}

/** 依頼の生成の進み（読み上げは polite）。質問が来たら選択肢を出す */
function Progress({
  state,
  joinedCount,
  helperCount,
  onAnswer,
  onClose,
  liveRef,
}: {
  state: GenState;
  joinedCount: number;
  helperCount: number;
  onAnswer: (a: { choiceId: string } | { text: string }) => void;
  onClose: () => void;
  liveRef: RefObject<HTMLDivElement | null>;
}) {
  let body: ReactNode = null;
  switch (state.phase) {
    case "generating":
      body = (
        <div className="pw-progress">
          <p className="pw-progress-line">頼みました。担当たちが段取りを決めています…</p>
          {state.slow && <p className="muted small">まだ考えています</p>}
        </div>
      );
      break;
    case "question":
      body = state.question ? <Question q={state.question} onAnswer={onAnswer} /> : null;
      break;
    case "shown": {
      const total = joinedCount + helperCount;
      body = (
        <div className="pw-progress is-shown">
          <p className="pw-progress-line">
            {total > 0 ? `${total}人で取りかかります` : "取りかかります"}
            {helperCount > 0 && `（応援 ${helperCount}人）`}
          </p>
          {state.shapeLine && <p className="muted small">{state.shapeLine}</p>}
          <div className="pw-progress-actions">
            {state.askId && (
              <Link to={`/asks/${state.askId}`} className="btn btn-primary">
                依頼のページを開く
              </Link>
            )}
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              閉じる
            </button>
          </div>
        </div>
      );
      break;
    }
    default:
      body = null;
  }
  return (
    <div aria-live="polite" className="pw-live" ref={liveRef}>
      {body}
    </div>
  );
}

/** 生成中の質問（入口の質問と同じ選択肢。作業場の中に出す） */
function Question({ q, onAnswer }: { q: NonNullable<GenState["question"]>; onAnswer: (a: { choiceId: string } | { text: string }) => void }) {
  const [writing, setWriting] = useState(false);
  const [own, setOwn] = useState("");
  const ownId = useId();
  const noChoices = q.choices.length === 0;
  return (
    <section className="question pw-question">
      <h3 className="pw-question-text">{q.text}</h3>
      <div className="choices left">
        {q.choices.slice(0, 4).map((c) => (
          <button key={c.id} type="button" className="chip choice" onClick={() => onAnswer({ choiceId: c.id })}>
            {c.label}
          </button>
        ))}
        {(q.allowFreeText || noChoices) && !writing && (
          <button type="button" className="chip choice-own" onClick={() => setWriting(true)}>
            自分で書く
          </button>
        )}
      </div>
      {writing && (
        <form
          className="own-answer"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (own.trim()) onAnswer({ text: own.trim() });
          }}
        >
          <label htmlFor={ownId} className="sr-only">
            答えを書く
          </label>
          <input id={ownId} value={own} onChange={(e) => setOwn(e.target.value)} autoFocus maxLength={2000} />
          <button type="submit" className="btn btn-primary" disabled={!own.trim()}>
            送る
          </button>
        </form>
      )}
    </section>
  );
}

/** 頼む欄（入口の composer-box と同じ見た目。Enter で送る・Shift+Enter で改行・変換中の Enter は送らない） */
function Composer({
  value,
  onChange,
  onSubmit,
  disabled,
  sending,
  placeholder,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  disabled: boolean;
  /** 頼んだ依頼の生成中（送るのは止める） */
  sending: boolean;
  placeholder: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const id = useId();
  // 複数行まで伸びる（最大 5 行）
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const line = parseFloat(getComputedStyle(el).lineHeight) || 24;
    el.style.height = `${Math.min(el.scrollHeight, line * 5 + 24)}px`;
  }, [value, inputRef]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing || e.shiftKey) return;
    e.preventDefault();
    onSubmit(value);
  };
  const empty = value.trim() === "";
  return (
    <form
      className="composer-box pw-composer"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value);
      }}
    >
      <label htmlFor={id} className="sr-only">
        この作業場に頼みたいこと
      </label>
      <textarea
        id={id}
        ref={inputRef}
        rows={1}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        maxLength={2000}
        enterKeyHint="send"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="submit" className={`round-btn ${empty ? "ghost" : "solid"}`} aria-label="頼む" disabled={disabled || sending || empty}>
        <ArrowUpIcon />
      </button>
    </form>
  );
}
