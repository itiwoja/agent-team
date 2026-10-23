// SCR-020：チャット（`/`）。依頼をひとつの会話に古い順で並べ、いちばん下の入力欄から話しかける（新しい会話を始める操作はない）。
// 送った文の行き先は lib/chat.ts の routeOf（直前の依頼に続けられれば返事、そうでなければ新しい依頼）。新しい依頼は会話の下でたまご → エージェントが生まれる。
// 依頼ごとの細かいこと（エージェントの動き・送る前の確認・ファイル）は「詳しく」から依頼のページ（/asks/:id）で見る
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { api, describeError, type AskDetail, type AskSummary, type AskTurnView } from "../api";
import { Avatar } from "../components/Avatar";
import { Egg, GenFormation } from "../components/GenStage";
import { LoadError } from "../components/LoadError";
import { Markdown } from "../components/Markdown";
import { SkeletonCards } from "../components/Skeleton";
import { CHAT_LIMIT, chatOrder, isLive, routeOf } from "../lib/chat";
import { readDraft, writeDraft } from "../lib/draft";
import { formatTime } from "../lib/format";
import { enterAskDelay, type GenState } from "../lib/generation";
import { pickExamples, readPrefill } from "../lib/prefill";
import { Link, replaceUrl } from "../lib/router";
import { noAnswerText, pendingReplyLabel, replyAvailability, replySentNote, turnsOf } from "../lib/turns";
import { useAskGeneration } from "../lib/useAskGeneration";
import { ArrowUpIcon } from "../ui/icons";
import { useWorkspace, useWorkspaceEvent } from "../workspace";
import { AgentQuestionCard, NextActions } from "./AskPage";

/** 動いている依頼がある間に取り直す間隔 */
const LIVE_POLL_MS = 3000;

/** 入力欄の例文（A-96：固定の候補 10 個。毎回入れ替える） */
const EXAMPLES = [
  "明日の午後に30分の打ち合わせを入れて",
  "毎朝7時にニュースをまとめて",
  "このリポジトリの未解決の Issue を整理して",
  "来週の予定を確認して、重なっているものを教えて",
  "週に一度、依存関係の更新を調べて",
  "お客さんからの問い合わせメールを整理して",
  "今月の売上をまとめて、先月と比べて",
  "毎週金曜に、今週の予定をふり返って",
  "新しい技術の記事を3本調べて、要点をまとめて",
  "競合の値段を調べて、表にして",
];

export function Chat() {
  const { online } = useWorkspace();
  const [asks, setAsks] = useState<AskSummary[] | null>(null);
  const [details, setDetails] = useState<Record<string, AskDetail>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  // 要求番号。load() が並行に走ったとき、古い応答で新しい応答を上書きしない
  const seq = useRef(0);
  const detailsRef = useRef(details);
  detailsRef.current = details;

  // 一覧を取り、中身が変わった依頼（と動いている依頼）だけ詳しく取り直す
  const load = useCallback(async () => {
    const my = ++seq.current;
    try {
      const { asks: list } = await api.asks(CHAT_LIMIT);
      if (my !== seq.current) return;
      const known = detailsRef.current;
      const stale = list.filter((a) => isLive(a.status) || known[a.id]?.ask.updatedAt !== a.updatedAt);
      const fetched = await Promise.all(stale.map((a) => api.ask(a.id).catch(() => null)));
      if (my !== seq.current) return;
      setAsks(chatOrder(list));
      setDetails((prev) => {
        const next = { ...prev };
        for (const d of fetched) if (d) next[d.ask.id] = d;
        return next;
      });
      setLoadError(null);
    } catch (err) {
      if (my === seq.current) setLoadError(describeError(err));
    }
  }, []);

  const gen = useAskGeneration({ onLateAsk: () => void load() });
  const { state, reset } = gen;

  useEffect(() => void load(), [load]);

  // 依頼の事象（ask.*）が来たら少し待って取り直す（続けて来たらまとめる）
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useWorkspaceEvent((type) => {
    if (!type.startsWith("ask.")) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(), 400);
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  // 動いている依頼がある間は取り直し続ける（事象の取りこぼしに備える）
  const anyLive = asks?.some((a) => isLive(a.status)) ?? false;
  useEffect(() => {
    if (!anyLive) return;
    const id = setInterval(() => void load(), LIVE_POLL_MS);
    return () => clearInterval(id);
  }, [anyLive, load]);

  // 生まれたエージェントを少し見せてから、会話の中の依頼に置き換える（ページは移らない）
  useEffect(() => {
    if (state.phase !== "shown") return;
    const id = setTimeout(() => {
      void load().then(reset);
    }, enterAskDelay(state.members.length));
    return () => clearTimeout(id);
  }, [state.phase, state.members.length, load, reset]);

  // 書きかけの文はほかの画面へ移っても残す（lib/draft.ts。送ったら消える）
  const [text, setText] = useState(readDraft);
  useEffect(() => writeDraft(text), [text]);
  const [{ placeholder, chips }] = useState(() => {
    const [first = EXAMPLES[0] ?? ""] = pickExamples(EXAMPLES, 1);
    return { placeholder: `例：${first}`, chips: pickExamples(EXAMPLES, 3, [first]) };
  });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendNote, setSendNote] = useState<string | null>(null);

  // `/?text=…` で開かれたら、その文を入力欄に入れてフォーカスし、URL を `/` に戻す（送りはしない）
  useEffect(() => {
    const pre = readPrefill(location.search);
    if (pre === null) return;
    replaceUrl("/");
    setText(pre);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);
  const connectNote = useConnectNote();

  // 作れなかったら、送った文を入力欄に戻す
  useEffect(() => {
    if (state.phase === "failed") setText(state.sentText);
  }, [state.phase, state.sentText]);

  // 生成中の依頼は、会話の下のたまご・編成で見せる（一覧に先に出ても重ねない）
  const generatingId = state.phase === "idle" || state.phase === "failed" ? null : state.askId;
  const shown = (asks ?? []).filter((a) => a.id !== generatingId);
  const lastAsk = shown[shown.length - 1];
  const latest = lastAsk ? (details[lastAsk.id] ?? null) : null;

  const submit = (value: string) => {
    const t = value.trim();
    if (!t || sending || gen.busy || !online) return;
    setSendError(null);
    setSendNote(null);
    const route = routeOf(latest, Date.now());
    if (route.kind === "new") {
      if (gen.submit(t)) setText("");
      return;
    }
    setSending(true);
    api
      .replyAsk(route.askId, t)
      .then((res) => {
        setText("");
        setSendNote(replySentNote(res));
        return load();
      })
      .catch((err: unknown) => setSendError(describeError(err)))
      .finally(() => setSending(false));
  };

  // 会話の下に付いていく：最初に読めたとき・やり取りが増えたときに、いちばん下へ（上を読んでいる間は動かさない）
  const atBottom = useRef(true);
  useEffect(() => {
    const onScroll = () => {
      atBottom.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 120;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const turnCount = shown.reduce((n, a) => n + (details[a.id] ? turnsOf(details[a.id]!).length + 1 : 1), 0);
  useLayoutEffect(() => {
    if (atBottom.current) toBottom();
  }, [turnCount, asks === null, state.phase]);
  // 回答の本文が後から伸びても（Markdown・画像）、下に付いたままにする
  const logRef = useRef<HTMLDivElement>(null);
  const hasLog = asks !== null;
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current) toBottom();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasLog]);

  if (asks === null && loadError) return <LoadError message={loadError} onRetry={load} />;
  if (asks === null) return <SkeletonCards count={3} head />;

  const idle = state.phase === "idle" || state.phase === "failed";
  const empty = shown.length === 0 && idle;
  const lastId = lastAsk?.id ?? null;

  return (
    <div className="chat">
      <h1 className="sr-only">チャット</h1>
      <div ref={logRef} className={empty ? "chat-log is-empty" : "chat-log"} aria-live="polite">
        {empty && <p className="hero entrance-title">頼むだけで、あなたのエージェントが生まれる</p>}
        {shown.map((a) => (
          <ChatAsk key={a.id} summary={a} detail={details[a.id] ?? null} last={a.id === lastId} onChanged={load} blocked={!online} />
        ))}
        {!idle && <ChatGen state={state} onAnswer={gen.answer} />}
        {loadError && <p className="error small" role="status">{loadError}</p>}
      </div>
      <div className="dock">
        {connectNote && (
          <p className={`entrance-note connect-note${connectNote.error ? " error" : " muted"}`} role="status">
            {connectNote.text}
          </p>
        )}
        {empty && !text.trim() && online && (
          <div className="entrance-examples" role="group" aria-label="頼み方の例">
            {chips.map((ex) => (
              <button
                key={ex}
                type="button"
                className="chip entrance-example"
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
        {state.phase === "failed" && (
          <p className="error entrance-note" role="alert">
            {state.message}
          </p>
        )}
        {sendError && (
          <p className="error entrance-note" role="alert">
            {sendError}
          </p>
        )}
        {sendNote && (
          <p className="muted entrance-note" role="status">
            {sendNote}
          </p>
        )}
        {!online && <p className="muted entrance-note">つながっていません</p>}
        <Composer
          value={text}
          onChange={setText}
          onSubmit={submit}
          disabled={!online || !idle}
          busy={sending}
          placeholder={shown.length === 0 ? placeholder : "話しかける"}
          inputRef={inputRef}
        />
      </div>
    </div>
  );
}

/** 会話の中の依頼ひとつ：頼んだこと → 回答 の往復（返事のたびに増える）。最後の依頼にだけ「次の手」を出す */
function ChatAsk({ summary, detail, last, onChanged, blocked }: { summary: AskSummary; detail: AskDetail | null; last: boolean; onChanged: () => void; blocked: boolean }) {
  const reload = () => void onChanged();
  if (!detail) {
    return (
      <div className="chat-ask">
        <UserBubble text={summary.text} at={summary.createdAt} />
      </div>
    );
  }
  const turns = turnsOf(detail);
  const reporter = detail.answer?.spokesperson?.agentName ?? detail.stages.find((s) => s.isAggregator)?.agentName ?? detail.stages[0]?.agentName ?? "エージェント";
  const latest = turns[turns.length - 1] ?? null;
  const failure = detail.ask.status === "failed" && detail.ask.failure ? detail.ask.failure.message : null;
  const pendingReplies = detail.pendingReplies ?? [];
  const nextActions = latest?.answer?.nextActions ?? [];
  const showNext = last && replyAvailability(detail).show && detail.ask.status !== "running" && pendingReplies.length === 0 && nextActions.length > 0;
  const approvals = detail.pendingIntents.length;
  return (
    <div className="chat-ask">
      {turns.length === 0 && <UserBubble text={detail.ask.text} at={detail.ask.createdAt} />}
      {turns.map((t, i) => (
        <ChatTurn key={t.runId} t={t} last={i === turns.length - 1} reporter={t.answer?.spokesperson?.agentName ?? reporter} triggerLabel={detail.ask.trigger?.label ?? null} stopped={detail.resume !== null} />
      ))}
      {turns.length === 0 && !failure && detail.ask.status !== "cancelled" && <AgentPending name={null} />}
      {failure && <AgentNote tone="failed">{failure}</AgentNote>}
      {detail.resume && (
        <AgentNote tone="failed">
          {detail.resume.agentName}で止まりました。<Link to={`/asks/${encodeURIComponent(detail.ask.id)}`}>やり直すか終えるかを選ぶ</Link>
        </AgentNote>
      )}
      {approvals > 0 && (
        <AgentNote tone="attention">
          <Link to={`/asks/${encodeURIComponent(detail.ask.id)}#approvals`}>送る前の確認が {approvals} 件あります</Link>
        </AgentNote>
      )}
      {(detail.agentQuestions ?? []).map((q) => (
        <AgentQuestionCard key={q.questionId} askId={detail.ask.id} q={q} onAnswered={reload} blocked={blocked} />
      ))}
      {pendingReplies.map((p) => (
        <UserBubble key={p.id} text={pendingReplyLabel(p.text)} at={p.createdAt} queued />
      ))}
      {showNext && <NextActions askId={detail.ask.id} actions={nextActions} onReply={reload} blocked={blocked} />}
      <Link to={`/asks/${encodeURIComponent(detail.ask.id)}`} className="chat-detail-link">
        詳しく
      </Link>
    </div>
  );
}

function ChatTurn({ t, last, reporter, triggerLabel, stopped }: { t: AskTurnView; last: boolean; reporter: string; triggerLabel: string | null; stopped: boolean }) {
  return (
    <>
      {t.kind === "schedule" ? (
        <p className="chat-divider">
          <span>{triggerLabel ? `定期の実行（${triggerLabel}）` : "定期の実行"} · {formatTime(t.startedAt)}</span>
        </p>
      ) : (
        <UserBubble text={t.text} at={t.startedAt} />
      )}
      {t.answer ? (
        <div className="chat-agent">
          <Avatar name={reporter} mood="done" size={32} />
          <div className="chat-agent-body">
            <p className="chat-meta">
              {reporter} · <time dateTime={t.answer.answeredAt}>{formatTime(t.answer.answeredAt)}</time>
            </p>
            {t.answer.unchanged && <p className="unchanged-badge">前回から変化はありません</p>}
            <div className="chat-bubble chat-bubble-agent">
              <Markdown className="answer-text" text={t.answer.conclusion} />
            </div>
          </div>
        </div>
      ) : last && !stopped && !noAnswerText(t.status) ? (
        <AgentPending name={reporter} />
      ) : !stopped ? (
        <AgentNote tone="muted">{noAnswerText(t.status) ?? "回答はありません"}</AgentNote>
      ) : null}
    </>
  );
}

function UserBubble({ text, at, queued = false }: { text: string; at: string; queued?: boolean }) {
  return (
    <div className={queued ? "turn-ask chat-user turn-queued" : "turn-ask chat-user"}>
      <p className="turn-ask-meta">
        <time dateTime={at}>{formatTime(at)}</time>
      </p>
      <p className="turn-ask-text">{text}</p>
    </div>
  );
}

function AgentPending({ name }: { name: string | null }) {
  return (
    <div className="chat-agent" role="status">
      {name ? <Avatar name={name} mood="running" size={32} /> : <span className="chat-agent-spacer" />}
      <p className="chat-bubble chat-bubble-agent chat-typing">
        {name ? `${name}が取り組んでいます` : "エージェントが取り組んでいます"}
        <span className="chat-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      </p>
    </div>
  );
}

function AgentNote({ tone, children }: { tone: "muted" | "failed" | "attention"; children: ReactNode }) {
  return <p className={`chat-note is-${tone}`}>{children}</p>;
}

/** ページのいちばん下へ（入力欄は下に貼り付いているので、要素ではなくページの端に合わせる） */
function toBottom() {
  window.scrollTo(0, document.documentElement.scrollHeight);
}

/** 新しい依頼の生成：送った文 → たまご（・質問）→ 生まれたエージェント */
function ChatGen({ state, onAnswer }: { state: GenState; onAnswer: (a: { choiceId: string } | { text: string }) => void }) {
  return (
    <div className="chat-ask">
      <UserBubble text={state.sentText} at={new Date().toISOString()} />
      {state.phase === "generating" && (
        <div className="chat-gen" role="status">
          <Egg />
          <p className="muted">エージェントを作っています…{state.slow && "（まだ考えています）"}</p>
        </div>
      )}
      {state.phase === "question" && state.question && <GenQuestion q={state.question} onAnswer={onAnswer} />}
      {state.phase === "shown" && <GenFormation state={state} heading="h2" />}
    </div>
  );
}

function GenQuestion({ q, onAnswer }: { q: NonNullable<GenState["question"]>; onAnswer: (a: { choiceId: string } | { text: string }) => void }) {
  const [writing, setWriting] = useState(false);
  const [own, setOwn] = useState("");
  return (
    <div className="chat-agent">
      <span className="chat-agent-spacer" />
      <div className="chat-agent-body">
        <p className="chat-bubble chat-bubble-agent">{q.text}</p>
        <div className="choices left">
          {q.choices.slice(0, 4).map((c) => (
            <button key={c.id} type="button" className="chip choice" onClick={() => onAnswer({ choiceId: c.id })}>
              {c.label}
            </button>
          ))}
          {(q.allowFreeText || q.choices.length === 0) && !writing && (
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
            <label htmlFor="own-answer" className="sr-only">
              答えを書く
            </label>
            <input id="own-answer" value={own} onChange={(e) => setOwn(e.target.value)} autoFocus maxLength={2000} />
            <button type="submit" className="btn btn-primary" disabled={!own.trim()}>
              送る
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

/** Google カレンダー・GitHub の接続の結果（/?connected=gcal|github・/?connect_error=…。読んだら URL を / に戻し、数秒で消す） */
function useConnectNote(): { text: string; error: boolean } | null {
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    const connected = p.get("connected");
    const failed = p.get("connect_error");
    if (connected === null && failed === null) return;
    replaceUrl("/");
    if (connected === "gcal") setNote({ text: "Google カレンダーをつなぎました", error: false });
    else if (connected === "github") setNote({ text: "GitHub をつなぎました。リポジトリの依頼を出せます", error: false });
    else setNote({ text: CONNECT_ERROR_TEXT[failed ?? "failed"] ?? "つなげませんでした。もう一度お試しください", error: true });
  }, []);
  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 6000);
    return () => clearTimeout(id);
  }, [note]);
  return note;
}

/** Google カレンダー・GitHub の接続の失敗の文（理由の内訳は出さない） */
const CONNECT_ERROR_TEXT: Record<string, string> = {
  denied: "Google カレンダーへの許可がなかったので、つなげませんでした",
  scope: "必要な権限がそろわなかったので、つなげませんでした",
  unavailable: "Google カレンダーは、いまは使えません",
  state: "Google カレンダーをつなげませんでした。もう一度お試しください",
  failed: "Google カレンダーをつなげませんでした。もう一度お試しください",
  github_denied: "GitHub への許可がなかったので、つなげませんでした",
  github_not_installed: "GitHub App が入っていないので、つなげませんでした。GitHub の画面でリポジトリを選んで入れてください",
  github_unavailable: "GitHub は、いまは使えません",
  github_state: "GitHub をつなげませんでした。もう一度お試しください",
  github_failed: "GitHub をつなげませんでした。もう一度お試しください",
};

function Composer({
  value,
  onChange,
  onSubmit,
  disabled,
  busy,
  placeholder,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  disabled: boolean;
  busy: boolean;
  placeholder: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  // 複数行まで伸びる（最大 5 行）
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const line = parseFloat(getComputedStyle(el).lineHeight) || 24;
    el.style.height = `${Math.min(el.scrollHeight, line * 5 + 24)}px`;
  }, [value, inputRef]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 日本語の変換中の Enter は送らない。Enter で送る・Shift+Enter で改行
    if (e.key !== "Enter" || e.nativeEvent.isComposing || e.shiftKey) return;
    e.preventDefault();
    onSubmit(value);
  };

  const empty = value.trim() === "";

  return (
    <form
      className="composer-box"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value);
      }}
    >
      <label htmlFor="ask-input" className="sr-only">
        話しかける
      </label>
      <textarea
        id="ask-input"
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
      {/* 送るボタンは常に矢印。空のときは薄い ghost で押せない（F-011：マイクに見せない） */}
      <button type="submit" className={`round-btn ${empty ? "ghost" : "solid"}`} aria-label="送る" disabled={disabled || empty || busy}>
        <ArrowUpIcon />
      </button>
    </form>
  );
}
