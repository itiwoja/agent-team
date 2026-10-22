// SCR-021：依頼（`/asks/:askId`）。上から「あなたの番（止まった担当・送る前の確認）」→「回答」→「担当」。
// 担当は1行にたたみ、いま動いているときだけ開いておく（読む量をいま要るものに絞る）
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, describeError, taskFilesUrl, type AgentQuestionView, type ApprovalItem, type AskAnswerView, type AskDetail, type AskMessageView, type AskTurnView, type StageActivity, type StageView } from "../api";
import { Avatar } from "../components/Avatar";
import { CheckRow } from "../components/CheckRow";
import { LoadError } from "../components/LoadError";
import { GoogleCalendarHint } from "../components/GoogleCalendarLine";
import { GithubHint } from "../components/GithubLine";
import { Markdown } from "../components/Markdown";
import { SkeletonCards } from "../components/Skeleton";
import { formatTime } from "../lib/format";
import { noticeHeadline, noticeLead } from "../lib/notice";
import { noAnswerText, pendingReplyLabel, replyAvailability, replySentNote, showsRequest, turnLabel, turnsOf } from "../lib/turns";
import { moodOfStage } from "../lib/avatar";
import { activityMark, stageClock } from "../lib/progress";
import { dependencies, isWorking, stageLabel, teamCounts } from "../lib/teamActivity";
import { useScreenTitle } from "../lib/title";
import { copyLabel, canCopy, useCopy } from "../lib/useCopy";
import { useElapsedSeconds } from "../lib/useElapsed";
import { Link, useLocationHash } from "../lib/router";
import { Chevron } from "../ui/icons";
import { threadMessages } from "../lib/placement";
import { useWorkspace, useWorkspaceEvent } from "../workspace";

/** 担当が動いている間に取り直す間隔 */
const LIVE_POLL_MS = 3000;

/** URL の #の後ろの要素 ID（空や壊れた符号化なら null） */
export function targetIdOf(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw === "") return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export function AskPage({ askId }: { askId: string }) {
  const { killSwitchEngaged, online } = useWorkspace();
  const [detail, setDetail] = useState<AskDetail | null>(null);
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  // 送る前の確認だけ取れなかった（区画の位置に知らせて、もう一度を出す）
  const [approvalsError, setApprovalsError] = useState(false);
  const [messages, setMessages] = useState<AskMessageView[]>([]);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  // 一通り読み込めたか（送る前の確認の区画が描画された後で、#で指された場所へ移るため）
  const [loaded, setLoaded] = useState(false);
  const hash = useLocationHash();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 要求番号。load() が並行に走ったとき、古い応答で新しい応答を上書きしない
  const seq = useRef(0);

  const load = useCallback(async () => {
    const my = ++seq.current;
    const fresh = () => my === seq.current;
    try {
      const d = await api.ask(askId);
      if (!fresh()) return;
      setDetail(d);
      setError(null);
      setNotFound(false);
      const [ap, ms] = await Promise.all([
        d.pendingIntents.length > 0 ? api.approvals({ askId, status: "pending" }).catch(() => null) : Promise.resolve({ items: [] }),
        d.messageCount > 0 ? api.askMessages(askId).catch(() => ({ messages: [] })) : Promise.resolve({ messages: [] }),
      ]);
      if (!fresh()) return;
      if (ap === null) {
        setApprovalsError(true);
      } else {
        setApprovalsError(false);
        setApprovals(
          ap.items.map((a) => ({ key: `approval:${a.id}`, kind: "approval", title: a.title, subtitle: a.subtitle, agent: a.agent, askId: a.askId, at: a.createdAt, opened: a.openReason !== null, approval: a })),
        );
      }
      setMessages(ms.messages);
      setLoaded(true);
    } catch (e) {
      if (!fresh()) return;
      if (e instanceof ApiError && e.status === 404) setNotFound(true);
      else setError(describeError(e));
    }
  }, [askId]);

  useEffect(() => {
    setDetail(null);
    setNotFound(false);
    void load();
    return () => clearTimeout(timer.current);
  }, [load]);

  useWorkspaceEvent((type, data) => {
    if (type === "reset") return void load();
    const forThis = (data as { askId?: string } | null)?.askId === askId;
    if ((type.startsWith("ask.") && forThis) || type.startsWith("check.")) {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void load(), 300);
    }
  });

  // 担当が動いている間・回答をまとめている間は、ツールの呼び出し（SSE の事象にならない）を見せるため数秒ごとに取り直す
  const live = detail !== null && (detail.stages.some((s) => s.state === "running") || detail.answerPending !== null);
  // タブの題を依頼の文にする（履歴やタブの一覧で見分けられるように）
  useScreenTitle(detail?.ask.text ?? null);
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, LIVE_POLL_MS);
    return () => clearInterval(id);
  }, [live, load]);

  // hash が変わったら、読み込み後に対象へ移してフォーカスする。
  // main へのフォーカス（main.tsx の effect）は画面が変わった時点で済んでいて、これは読み込みの後に動く
  useEffect(() => {
    if (!loaded) return;
    const id = targetIdOf(hash);
    const el = id ? document.getElementById(id) : null;
    if (!el) return;
    // 区画（section・ul など）はそのままではフォーカスできないので、プログラムからのフォーカスだけ受けるようにする
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
    el.scrollIntoView({ block: "start" });
    el.focus({ preventScroll: true });
  }, [loaded, hash]);

  const visible = approvals.filter((a) => !hidden.has(a.key));
  const hide = useCallback((key: string) => setHidden((h) => new Set(h).add(key)), []);

  if (notFound) {
    return (
      <div className="ask">
        <h1>この依頼は見つかりません</h1>
        <p>
          <Link to="/" className="btn btn-ghost">
            任せるへ戻る
          </Link>
        </p>
      </div>
    );
  }
  if (!detail) {
    return error ? <LoadError message={error} onRetry={load} /> : <SkeletonCards count={2} sizes={["lg", "sm"]} head />;
  }
  const { ask, formation } = detail;

  return (
    <div className="ask">
      <header className="ask-head">
        <AskTitle text={ask.text} />
        {ask.trigger && (
          <p className="muted ask-schedule">
            {ask.trigger.label}に動きます
            {ask.trigger.nextRunAt && (
              <>
                {" · 次は "}
                <time dateTime={ask.trigger.nextRunAt}>{formatTime(ask.trigger.nextRunAt)}</time>
              </>
            )}
          </p>
        )}
        <GoogleCalendarHint needs={ask.needsConnection} />
        <GithubHint needs={ask.needsConnection} />
        {formation?.notes.map((n) => (
          <p key={n} className="muted">
            {n}
          </p>
        ))}
      </header>

      {/* あなたの番：止まった担当のやり直し・送る前の確認。あれば回答より先に */}
      {detail.resume && <Resume askId={askId} resume={detail.resume} onDone={() => load()} blocked={killSwitchEngaged || !online} />}

      {approvalsError ? (
        <section className="block" id="approvals" aria-label="送る前の確認">
          <p className="error" role="alert">
            送る前の確認を読み込めませんでした
          </p>
          <button type="button" className="btn btn-ghost" onClick={() => void load()}>
            もう一度
          </button>
        </section>
      ) : (
        visible.length > 0 && (
          <ul className="rows block" id="approvals" aria-label="送る前の確認">
            {visible.map((i) => (
              <CheckRow key={i.key} item={i} onGone={hide} onReload={() => void load()} />
            ))}
          </ul>
        )
      )}

      {ask.status === "failed" ? (
        <FailedCard text={ask.text} reason={ask.failure?.reason ?? null} message={ask.failure?.message ?? "作れませんでした"} />
      ) : (
        <Conversation detail={detail} approvals={visible.length} onReply={() => load()} blocked={killSwitchEngaged || !online} stopped={detail.resume !== null} />
      )}

      <Stages detail={detail} messages={messages} stale={Boolean(error) || !online} />
    </div>
  );
}

/** 題は頼んだ文そのもの。長い文は3行で畳み、「全文」で開く（畳んでいることは下端のぼかしでも分かる） */
function AskTitle({ text }: { text: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  const [over, setOver] = useState(false);
  const [full, setFull] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || full) return;
    const measure = () => setOver(el.scrollHeight > el.clientHeight + 2);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, full]);
  return (
    <>
      <h1 ref={ref} className={full ? "ask-title" : over ? "ask-title is-clamped" : "ask-title is-clampable"}>
        {text}
      </h1>
      {over && (
        <button type="button" className="link quiet ask-title-toggle" aria-expanded={full} onClick={() => setFull((v) => !v)}>
          {full ? "たたむ" : "全文を見る"}
        </button>
      )}
    </>
  );
}

/** 依頼が失敗したとき（回答の代わり）。赤は点とアイコンだけに使い、面は --surface のまま */
/** 一時的な失敗（時間切れ・Gemini の失敗）は同じ文で送り直せばよい。それ以外は言い方を変えて頼み直す */
const RETRYABLE_FAILURES = new Set(["timeout", "planner_error"]);

function FailedCard({ text, reason, message }: { text: string; reason: string | null; message: string }) {
  return (
    <section className="block card ask-failed" aria-label="うまくいきませんでした">
      <div className="ask-failed-head">
        <span className="ask-failed-dot" aria-hidden="true" />
        <p className="ask-failed-message" role="alert">
          {message}
        </p>
      </div>
      <Link to={`/?text=${encodeURIComponent(text)}`} className="btn btn-primary">
        {reason !== null && RETRYABLE_FAILURES.has(reason) ? "もう一度送る" : "言い方を変えて頼む"}
      </Link>
    </section>
  );
}

/**
 * 頼んだこと → 回答 を古い順に並べる（返事のたびに1往復増える）。最後（今の実行）だけ全文を出し、前のものは1行に畳んで開ける。
 * 最初の依頼の文は見出しにあるので繰り返さず、返事の文は右寄せの面で「あなた」の発言として出す（どの文への回答かが分かるように）
 */
function Conversation({ detail, approvals, onReply, blocked, stopped }: { detail: AskDetail; approvals: number; onReply: () => void; blocked: boolean; stopped: boolean }) {
  const turns = turnsOf(detail);
  const last = turns.length - 1;
  const latest = turns[last] ?? null;
  const spokesperson = detail.stages.find(s => s.agentName === detail.answerPending?.spokespersonName && isWorking(s))?.agentName ?? null;
  // 回答の主（窓口。並列・Kernel が書いた回答はまとめ役か最初の担当）
  const reporterOf = (a: AskAnswerView | null): string =>
    a?.spokesperson?.agentName ?? detail.stages.find((st) => st.isAggregator)?.agentName ?? detail.stages[0]?.agentName ?? "担当";
  // 返事欄は会話の下に常に出す（並列・生成中・止まったときを除く）。動いている間に送ると順番待ちになる
  const reply = replyAvailability(detail);
  const canReply = reply.show;
  const pendingReplies = detail.pendingReplies ?? [];
  return (
    <section className="block thread" id="answer" aria-label="頼んだことと回答">
      {turns.length === 0 && !stopped && <PendingCard name={spokesperson} status="running" />}
      {turns.map((t, i) => (
        <Turn key={t.runId} t={t} latest={i === last} detail={detail} approvals={approvals} reporter={reporterOf(t.answer)} spokesperson={spokesperson} stopped={stopped} />
      ))}
      {(detail.agentQuestions ?? []).map((q) => (
        <AgentQuestionCard key={q.questionId} askId={detail.ask.id} q={q} onAnswered={onReply} blocked={blocked} />
      ))}
      {canReply && latest?.answer && detail.ask.status !== "running" && pendingReplies.length === 0 && (latest.answer.nextActions?.length ?? 0) > 0 && (
        <NextActions askId={detail.ask.id} actions={latest.answer.nextActions ?? []} onReply={onReply} blocked={blocked} />
      )}
      {pendingReplies.map((p) => (
        <div key={p.id} className="turn turn-queued">
          <div className="turn-ask">
            <p className="turn-ask-meta">
              <span className="turn-ask-who">あなた</span>
              <span>
                {" · "}
                <time dateTime={p.createdAt}>{formatTime(p.createdAt)}</time>
              </span>
            </p>
            <p className="turn-ask-text">{pendingReplyLabel(p.text)}</p>
          </div>
        </div>
      ))}
      {canReply && <ReplyForm askId={detail.ask.id} onReply={onReply} blocked={blocked} queues={reply.queues} />}
    </section>
  );
}

function Turn({ t, latest, detail, approvals, reporter, spokesperson, stopped }: { t: AskTurnView; latest: boolean; detail: AskDetail; approvals: number; reporter: string; spokesperson: string | null; stopped: boolean }) {
  const [open, setOpen] = useState(false);
  const label = turnLabel(t, detail.ask.trigger?.label ?? null);
  // 定期の実行が止まったとき：文のない「あなた · 定期の実行」の行だけが残るので、止まった担当のカード（Resume）に任せて出さない
  if (stopped && latest && t.answer === null && t.kind === "schedule") return null;
  return (
    <div className={latest ? "turn is-latest" : "turn"}>
      {showsRequest(t, detail.ask.text) && (
        <div className="turn-ask">
          <p className="turn-ask-meta">
            <span className="turn-ask-who">あなた</span>
            {label && <span> · {label}</span>}
            <span>
              {" · "}
              <time dateTime={t.startedAt}>{formatTime(t.startedAt)}</time>
            </span>
          </p>
          {/* 定期の実行は依頼の文のままなので繰り返さない */}
          {t.kind !== "schedule" && <p className="turn-ask-text">{t.text}</p>}
        </div>
      )}
      {t.answer === null ? (
        latest ? (
          // 止まった担当のカード（Resume）が同じことを言うので、重ねて出さない
          stopped ? null : <PendingCard name={spokesperson} status={t.status} />
        ) : (
          <p className="muted turn-none">{noAnswerText(t.status) ?? "回答はありません"}</p>
        )
      ) : latest || open ? (
        <AnswerCard detail={detail} turn={t} answer={t.answer} approvals={latest ? approvals : 0} reporter={reporter} latest={latest} onFold={latest ? undefined : () => setOpen(false)} />
      ) : (
        <button type="button" className="turn-folded" aria-expanded={false} onClick={() => setOpen(true)}>
          <Avatar name={reporter} mood="done" size={28} />
          <span className="turn-folded-text">
            <span className="turn-folded-meta">
              {reporter} · {formatTime(t.answer.answeredAt)}
            </span>
            <span className="turn-folded-lead">{noticeLead(t.answer.conclusion, 80) || "回答"}</span>
          </span>
          <span className="stage-chevron">
            <Chevron dir="right" />
          </span>
        </button>
      )}
    </div>
  );
}

/** 回答がまだのとき。動いている間は窓口の名前で「〇〇がまとめています」、止まっていればその旨 */
function PendingCard({ name, status }: { name: string | null; status: AskTurnView["status"] }) {
  const stopped = noAnswerText(status);
  return (
    <section className="block card" role="status">
      <h2 className="block-title">回答</h2>
      {stopped ? (
        <p className="muted">{stopped}</p>
      ) : (
        <p className="muted answer-pending">
          {name && <Avatar name={name} mood="running" size={32} />}
          <span>{name ? `${name}がまとめています` : "担当の作業・報告を待っています"}</span>
        </p>
      )}
    </section>
  );
}

/** 回答のカード。チャットの返事ではなく、担当からの報告として見せる（届いた知らせのカードと同じ見出し） */
function AnswerCard({
  detail,
  turn,
  answer,
  approvals,
  reporter,
  latest,
  onFold,
}: {
  detail: AskDetail;
  turn: AskTurnView;
  answer: AskAnswerView;
  approvals: number;
  reporter: string;
  latest: boolean;
  onFold?: () => void;
}) {
  // 見出しの手がかり（やったこと）は今の実行の段からだけ取れる。前の回答は頼んだ文から当てる
  const headline = noticeHeadline({ askText: turn.text, answer, stages: latest ? detail.stages : [] });
  const needsYou = answer.needsYou.line ?? (approvals > 0 ? `あなたの確認待ち：${approvals}件` : null);
  const { state: copyState, copy } = useCopy();
  const copyable = latest && canCopy() && answer.conclusion.trim() !== "";
  return (
    <section className={latest ? "block card report-card" : "block card report-card is-past"} aria-label={latest ? "回答" : "前の回答"}>
      <div className="report-head">
        <Avatar name={reporter} mood="done" size={44} />
        <div className="report-head-text">
          <p className="notice-who">
            {reporter} · <time dateTime={answer.answeredAt}>{formatTime(answer.answeredAt)}</time>
          </p>
          <h2 className="block-title report-headline">{headline}</h2>
        </div>
      </div>
      {answer.unchanged && <p className="unchanged-badge">前回から変化はありません</p>}
      <Markdown className="answer-text" text={answer.conclusion} />
      {/* 誰が何をしたか（Kernel が固定の文で差し込む行）。ひとりの依頼は段の一覧で足りる */}
      {answer.memberLines.length > 1 && (
        <ul className="plain answer-members" aria-label="誰が何をしたか">
          {answer.memberLines.map((m, i) => (
            <li key={i} className={m.failed ? "failed" : undefined}>
              <Avatar name={m.agentName} mood={m.failed ? "failed" : "done"} size={22} />
              <span>
                {m.agentName}：{m.text}
              </span>
            </li>
          ))}
        </ul>
      )}
      {/* 送る前の確認へのリンクは今の実行の分だけ（前の実行の確認はもう残っていない） */}
      {needsYou && (
        <p>
          {latest ? (
            <a href="#approvals" className="needs-you">
              {needsYou}
            </a>
          ) : (
            <span className="muted">{needsYou}</span>
          )}
        </p>
      )}
      {answer.needsYou.declinedLine && <p className="declined">{answer.needsYou.declinedLine}</p>}
      {answer.needsYou.stoppedMembers.length > 0 && <p className="failed">止まった担当：{answer.needsYou.stoppedMembers.join("、")}</p>}
      {answer.taintNote && <p className="muted">{answer.taintNote}</p>}
      {(onFold || copyable) && (
        <div className="report-foot">
          {/* 回答の本文（Markdown のまま）を写す。写せたら2秒だけ文を変える（読み上げは role=status） */}
          {copyable && (
            <button type="button" className={`link quiet report-copy${copyState !== "idle" ? " is-" + copyState : ""}`} aria-live="polite" onClick={() => copy(answer.conclusion)}>
              {copyLabel(copyState)}
            </button>
          )}
          {onFold && (
            <button type="button" className="link quiet turn-fold" onClick={onFold}>
              たたむ
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** 担当から利用者への質問（ask_user）。押すか書いて答えると、待っている担当がそのまま受け取って続ける */
function AgentQuestionCard({ askId, q, onAnswered, blocked }: { askId: string; q: AgentQuestionView; onAnswered: () => void; blocked: boolean }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = (body: { choiceId?: string; text?: string }) => {
    if (busy || blocked) return;
    setBusy(true);
    setError(null);
    api
      .answerAgentQuestion(askId, q.questionId, body)
      .then(onAnswered)
      .catch((err: unknown) => setError(describeError(err)))
      .finally(() => setBusy(false));
  };
  return (
    <section className="block card agent-question" aria-label={`${q.agentName}からの質問`}>
      <div className="agent-question-head">
        <Avatar name={q.agentName} mood="running" size={32} />
        <p className="notice-who">{q.agentName}から質問です（答えるまで待っています）</p>
      </div>
      <p className="agent-question-text">{q.text}</p>
      {q.choices.length > 0 && (
        <div className="choices left">
          {q.choices.map((c) => (
            <button key={c.id} type="button" className="btn btn-ghost" disabled={blocked || busy} onClick={() => send({ choiceId: c.id })}>
              {c.label}
            </button>
          ))}
        </div>
      )}
      {q.allowFreeText && (
        <form
          className="own-answer"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) send({ text: text.trim() });
          }}
        >
          <label htmlFor={`q-${q.questionId}`} className="sr-only">
            答え
          </label>
          <input id={`q-${q.questionId}`} placeholder="答えを書く" value={text} maxLength={500} disabled={busy || blocked} onChange={(e) => setText(e.target.value)} />
          <button type="submit" className="btn btn-primary" disabled={blocked || busy || !text.trim()}>
            {busy ? "送っています…" : "答える"}
          </button>
        </form>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** 窓口の「次の手の提案」。押すとその文を返事（API-077）として送り、窓口がそのまま動く */
function NextActions({ askId, actions, onReply, blocked }: { askId: string; actions: string[]; onReply: () => void; blocked: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const go = (text: string) => {
    if (busy !== null || blocked) return;
    setBusy(text);
    setError(null);
    api
      .replyAsk(askId, text)
      .then(onReply)
      .catch((err: unknown) => setError(describeError(err)))
      .finally(() => setBusy(null));
  };
  return (
    <div className="next-actions" aria-label="次にできること">
      <p className="next-actions-title">次はこれをしましょうか？</p>
      <div className="choices left">
        {actions.map((a) => (
          <button key={a} type="button" className="btn btn-ghost next-action" disabled={blocked || busy !== null} onClick={() => go(a)}>
            {busy === a ? "頼んでいます…" : a}
          </button>
        ))}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** 追加で頼む（API-077）。送ると窓口がもう一度動き、履歴に1往復増える */
function ReplyForm({ askId, onReply, blocked, queues }: { askId: string; onReply: () => void; blocked: boolean; queues: boolean }) {
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="reply-box">
      <form
        className="own-answer"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim() || busy || blocked) return;
          setBusy(true);
          setError(null);
          setNote(null);
          api
            .replyAsk(askId, text.trim())
            .then((res) => {
              setText("");
              setNote(replySentNote(res));
              onReply();
            })
            .catch((err: unknown) => setError(describeError(err)))
            .finally(() => setBusy(false));
        }}
      >
        <label htmlFor="reply" className="sr-only">
          追加で頼むこと
        </label>
        <input id="reply" placeholder={queues ? "追加で頼む（いまの作業のあとに始まります）" : "追加で頼む"} value={text} maxLength={2000} disabled={busy || blocked} onChange={(e) => setText(e.target.value)} />
        <button type="submit" className="btn btn-primary" disabled={blocked || !text.trim() || busy}>
          {busy ? "送っています…" : "送る"}
        </button>
      </form>
      {note && (
        <p className="muted" role="status">
          {note}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function Resume({ askId, resume, onDone, blocked }: { askId: string; resume: NonNullable<AskDetail["resume"]>; onDone: () => void; blocked: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = (action: "retry" | "finish") => {
    if (busy) return;
    setBusy(true);
    api
      .resumeAsk(askId, action)
      .then(onDone)
      .catch((e: unknown) => setError(describeError(e)))
      .finally(() => setBusy(false));
  };
  return (
    <section className="block card card-stopped">
      <p className="row-title">{resume.agentName}で止まりました</p>
      <p className="muted">{resume.reason}</p>
      <div className="choices left">
        <button type="button" className="btn btn-ghost" disabled={blocked || busy} onClick={() => go("retry")}>
          やり直す
        </button>
        <button type="button" className="btn btn-ghost" disabled={blocked || busy} onClick={() => go("finish")}>
          ここまでで終える
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function Stages({ detail, messages, stale = false }: { detail: AskDetail; messages: AskMessageView[]; stale?: boolean }) {
  const shape = detail.ask.shape ?? detail.formation?.shape ?? "single";
  const stages = useMemo(() => [...detail.stages].sort((a, b) => (a.isAggregator === b.isAggregator ? (a.position ?? 0) - (b.position ?? 0) : a.isAggregator ? 1 : -1)), [detail.stages]);
  if (stages.length === 0) return null;
  const counts = teamCounts(stages);
  const working = counts.working > 0 && !stale;
  const line = stale ? "最後に取得した状態" : counts.working > 1 ? `${counts.working}人が同時に作業中` : counts.working === 1 ? "1人が作業中" : counts.stopped > 0 ? "止まった担当がいます" : counts.done === stages.length ? `${stages.length}人 · 完了` : `${stages.length}人`;
  return (
    <details className="fold team-fold" open={working || stale} key={detail.run?.runId ?? "pending"}>
      <summary className="fold-summary">
        <h2 className="fold-title">担当</h2>
        <span className="fold-note" aria-live="polite">{line}</span>
        <span className="fold-faces" aria-hidden="true">
          {stages.slice(0, 5).map((s) => (
            <Avatar key={s.memberId} name={s.agentName} mood={moodOfStage(s.state === "running" && !isWorking(s) ? "waiting" : s.state)} size={26} />
          ))}
        </span>
        <Chevron />
      </summary>
    <section className={`block stages team-board team-simple${counts.working > 1 && !stale ? " is-parallel" : ""}`} aria-label="チームの活動">
      {stale && <p role="status" className="team-reason">更新できていません。</p>}
      <MobileTeam key={`mobile-${detail.run?.runId ?? "pending"}`} detail={detail} stages={stages} stale={stale} />
      <ol className="plain stage-list team-desktop">
        {stages.map(s => (
          <li key={`${detail.run?.runId}:${s.memberId}:${s.taskId ?? "pending"}`} className={isWorking(s) && !stale ? "team-member is-working" : "team-member"}>
            <Stage s={s} needs={dependencies(detail, s)} />
          </li>
        ))}
      </ol>
      <details className="team-extra" key={detail.run?.runId ?? "pending"}>
        <summary>受け渡し・実行の詳細</summary>
        <p className="team-run">{detail.run ? `実行 ${detail.run.runNo}` : "実行前"}</p>
        {detail.run?.triggerType === "manual" && <p className="muted">追加の依頼は窓口の担当がひとりで受けます。</p>}
        <div className="team-transfers">
          <h3>受け渡しの記録 <span>{detail.handoffs.length}件</span></h3>
          {detail.handoffs.length === 0 ? <p className="muted">この実行には受け渡しの記録がありません。</p> : <ul className="plain">{detail.handoffs.map((h,i)=><li key={i}><strong>{h.fromAgentName} → {h.toAgentName}</strong><span>受領済み · {h.label}{h.taintMark ? ` · ${h.taintMark}` : ""}</span></li>)}</ul>}
        </div>
        {shape === "aggregate" && <p className="team-boundary">まとめ役は読み取り専用です。次のチームに制作を任せる場合は、結果を渡して新しく依頼してください。</p>}
        {messages.length > 0 && <div className="team-transfers"><h3>担当間のやり取り</h3><ul className="plain exchange">{threadMessages(messages).map(({message:m,replies})=><li key={m.id}><p>{m.fromAgentName}「{m.body}」{m.tainted && "（外部の内容を含む）"}</p>{replies.map(r=><p key={r.id}>{r.fromAgentName}「{r.body}」</p>)}</li>)}</ul></div>}
      </details>
    </section>
    </details>
  );
}

function MobileTeam({ detail, stages, stale }: { detail: AskDetail; stages: StageView[]; stale: boolean }) {
  const [selected, setSelected] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const closing = useRef(false);
  const selectedStage = stages.find(s => s.memberId === selected);
  const isOpen = Boolean(selectedStage);
  useEffect(() => {
    if (!isOpen) return;
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = before; };
  }, [isOpen]);
  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    if (history.state?.teamPanel === detail.ask.id) history.back();
    else { setSelected(null); closing.current = false; }
  }, [detail.ask.id]);
  const choose = (memberId: string) => {
    if (closing.current) return;
    const state = { ...history.state, teamPanel: detail.ask.id, teamMember: memberId };
    if (history.state?.teamPanel === detail.ask.id) history.replaceState(state, "");
    else history.pushState(state, "");
    setSelected(memberId);
  };
  useEffect(() => {
    const pop = () => { closing.current = false; setSelected(history.state?.teamPanel === detail.ask.id ? history.state.teamMember : null); };
    const media = window.matchMedia("(max-width: 600px)");
    const resize = () => { if (!media.matches && history.state?.teamPanel === detail.ask.id) close(); };
    window.addEventListener("popstate", pop); media.addEventListener("change", resize);
    return () => {
      window.removeEventListener("popstate", pop); media.removeEventListener("change", resize);
      if (history.state?.teamPanel === detail.ask.id) { const {teamPanel, teamMember, ...rest} = history.state; history.replaceState(rest, ""); }
    };
  }, [detail.ask.id, close]);
  useEffect(() => {
    if (selectedStage) { if (!dialog.current?.open) dialog.current?.showModal(); }
    else dialog.current?.close();
  }, [selectedStage]);
  return <div className="team-mobile">
    <ul className="plain team-orbit" aria-label="担当一覧">
      {stages.map(s => { const state = s.state === "running" && !isWorking(s) ? "waiting" : s.state; return <li key={s.memberId}>
        <button type="button" className={`team-person${isWorking(s) && !stale ? " is-working" : ""}`} aria-label={`${s.agentName}、${stageLabel(s)}${s.files?.count ? `、成果物${s.files.count}件` : ""}。詳細を開く`} aria-haspopup="dialog" onClick={() => choose(s.memberId)}>
          <Avatar name={s.agentName} mood={moodOfStage(state)} size={48} />
          <span className="team-person-name">{s.agentName}</span>
          <span className={`stage-state is-${state}`}>{stageLabel(s)}</span>
          {Boolean(s.files?.count) && <span className="team-person-files">成果物 {s.files!.count}</span>}
        </button>
      </li>})}
    </ul>
    <dialog ref={dialog} className="team-mobile-sheet" aria-label="担当の詳細" onCancel={e => { e.preventDefault(); close(); }} onClick={e => { if (e.target === e.currentTarget) { const r=e.currentTarget.getBoundingClientRect(); if(e.clientY<r.top || e.clientX<r.left || e.clientX>r.right) close(); } }}>
      <div className="team-sheet-header"><span>担当の詳細</span><button type="button" className="btn btn-ghost" autoFocus onClick={close}>閉じる</button></div>
      {selectedStage && <>
        <label className="sr-only" htmlFor="team-select-member">担当を切り替える</label>
        <select id="team-select-member" value={selected ?? ""} onChange={e => choose(e.target.value)}>{stages.map(s=><option value={s.memberId} key={s.memberId}>{s.agentName}</option>)}</select>
        {stale && <p className="team-reason">最後に取得した状態です。</p>}
        <Stage key={`${selectedStage.memberId}:${selectedStage.taskId}`} s={selectedStage} needs={dependencies(detail, selectedStage)} />
      </>}
    </dialog>
  </div>;
}

function Stage({ s, needs }: { s: StageView; needs: string[] }) {
  const state = s.state === "running" && !isWorking(s) ? "waiting" : s.state;
  const failed = s.state === "failed";
  return (
    <div className={`stage is-${state}${failed ? " stage-failed" : ""}`}>
      <div className="team-identity">
        <Avatar name={s.agentName} mood={moodOfStage(state)} size={40} className="stage-avatar" />
        <h3 className="stage-name">{s.agentName}</h3>
        <span className={`stage-state is-${state}`}>{stageLabel(s)}</span>
      </div>
      <p className="team-role">{s.summary}</p>
      {s.isAggregator && <span className="team-readonly">読み取り専用</span>}
      {(failed || s.state === "stopped" || (s.state === "done" && s.stateText !== "済み")) && <p className="team-reason">{s.stateText}</p>}
      {s.taskId && s.files && s.files.count > 0 && <a className="stage-files" href={taskFilesUrl(s.taskId)} download>成果物をダウンロード（{s.files.count}件）</a>}
      <details className="team-member-detail">
        <summary>{s.report ? "報告・詳細" : "詳細"}<span className="sr-only">：{s.agentName}</span></summary>
        {s.reuseLine && <p className="muted small">{s.reuseLine}</p>}
        <StageProgress s={s} />
        {needs.length > 0 && <p className="team-dependency">受け取る予定：{needs.join("、")} の報告</p>}
        {s.report ? <Markdown className="row-detail" text={s.report.body} /> : <p className="muted small">報告はまだありません。</p>}
      </details>
    </div>
  );
}
/** やったこと（ツールの呼び出しの判定）と経過。動いている間は最後に「考えています…」と経過秒を出す */
function StageProgress({ s }: { s: StageView }) {
  const running = isWorking(s);
  const sec = useElapsedSeconds(s.startedAt, running);
  const activity = s.activity ?? [];
  const clock = stageClock(s, sec);
  if (activity.length === 0 && !running && clock === null) return null;
  return (
    <div className="stage-progress">
      <ol className="activity" aria-label={`${s.agentName}のやったこと`}>
        {/* 1回の応答の呼び出しは同じ時刻になるので、同じ時刻・同じ名前の何番目かまで鍵に入れる（古いものが窓から外れても残りを作り直さない） */}
        {activity.map((a, i) => (
          <ActivityChip key={`${a.at}:${a.label}:${activity.slice(0, i).filter((b) => b.at === a.at && b.label === a.label).length}`} a={a} />
        ))}
        {running && (
          <li className="activity-chip is-thinking">
            <span>応答を待っています</span>
            <span className="thinking-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </li>
        )}
      </ol>
      {clock && <span className="stage-clock">{clock}</span>}
    </div>
  );
}

function ActivityChip({ a }: { a: StageActivity }) {
  const m = activityMark(a.outcome);
  return (
    <li className={`activity-chip is-${a.outcome}`}>
      <span className="activity-mark" aria-hidden="true">
        {m.icon}
      </span>
      <span>{a.label}</span>
      {m.text && <span className="activity-note">{m.text}</span>}
    </li>
  );
}

/** 「1.2 KB」の形（作ったファイルの大きさ） */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
