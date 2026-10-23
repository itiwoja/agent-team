// 届いた知らせ：依頼の回答が出たら、どの画面にいても上からカードが降りてくる（「ニュース係 · リサーチしたよ！」）。
// カードを押すと、その場で下からシートが開き、要点だけをひと目で見て ○ で片づけられる（依頼のページへ移らなくてよい）。
// タブが裏にあるときは、許可があればブラウザの通知も出す
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api, describeError, type AskAnswerView } from "../api";
import { Avatar } from "./Avatar";
import { Markdown } from "./Markdown";
import { noticeHeadline, noticeLead, noticePoints } from "../lib/notice";
import { navigate, useRoute } from "../lib/router";
import { useRestoreFocus } from "../lib/useRestoreFocus";
import { trapTab } from "../ui/trapTab";
import { useWorkspace, useWorkspaceEvent } from "../workspace";

/** カードが自然に消えるまで（触っている間は止める） */
const TOAST_MS = 10_000;
/** 同時に出すカードの数（古いものから押し出す） */
const MAX_TOASTS = 3;

interface Notice {
  /** 走行の ID（同じ回答の知らせを2回出さない） */
  runId: string;
  askId: string;
  /** チェックの行の鍵（○ で片づける先） */
  key: string;
  agentName: string;
  headline: string;
  lead: string;
  /** どの頼みごとへの回答か（返事の実行は返事の文）。取れなければ null */
  request: string | null;
  answer: AskAnswerView;
}

/** ブラウザの通知の許可を、利用者の操作（頼んだとき）に合わせて1度だけ聞く */
export function askNoticePermission(): void {
  if (typeof Notification === "undefined" || Notification.permission !== "default") return;
  void Notification.requestPermission().catch(() => undefined);
}

export function Notices() {
  const route = useRoute();
  const [toasts, setToasts] = useState<Notice[]>([]);
  const [open, setOpen] = useState<Notice | null>(null);
  const seen = useRef(new Set<string>());
  const routeRef = useRef(route);
  routeRef.current = route;

  const dismiss = useCallback((runId: string) => setToasts((t) => t.filter((n) => n.runId !== runId)), []);

  const show = useCallback(
    (n: Notice) => {
      dismiss(n.runId);
      setOpen(n);
    },
    [dismiss],
  );

  // 担当からの質問（ask_user）：答えるまで担当が待っているので、どの画面にいても知らせる。押すと依頼のページへ
  const [questions, setQuestions] = useState<QuestionNotice[]>([]);
  const dropQuestion = useCallback((questionId: string) => setQuestions((q) => q.filter((x) => x.questionId !== questionId)), []);

  useWorkspaceEvent((type, data) => {
    if (type === "ask.agent_question" && data && typeof data === "object") {
      const { askId, questionId, status } = data as { askId?: string; questionId?: string; status?: string };
      if (!askId || !questionId) return;
      if (status !== "posted") return dropQuestion(questionId);
      const r = routeRef.current;
      if (r.name === "ask" && r.askId === askId && document.visibilityState === "visible") return;
      void api
        .ask(askId)
        .catch(() => null)
        .then((d) => {
          const q = d?.agentQuestions?.find((x) => x.questionId === questionId);
          if (!q) return;
          const n: QuestionNotice = { questionId, askId, agentName: q.agentName, text: q.text };
          setQuestions((list) => [n, ...list.filter((x) => x.questionId !== questionId)].slice(0, MAX_TOASTS));
          systemNotifyQuestion(n);
        });
      return;
    }
    if (type !== "ask.answered" || !data || typeof data !== "object") return;
    const { askId, runId, answer } = data as { askId?: string; runId?: string; answer?: AskAnswerView };
    if (!askId || !runId || !answer || seen.current.has(runId)) return;
    seen.current.add(runId);
    // 見張りの「前回から変化なし」は知らせない（依頼のページには残る）
    if (answer.unchanged === true) return;
    // その依頼のページを見ているなら、もう目の前にあるので出さない
    const r = routeRef.current;
    if (r.name === "ask" && r.askId === askId && document.visibilityState === "visible") return;
    void api
      .ask(askId)
      .catch(() => null)
      .then((d) => {
        // どの頼みごとへの回答か（返事の実行は返事の文）。見出しの手がかりにも使う
        const request = d?.turns?.find((t) => t.runId === runId)?.text ?? d?.ask.text ?? null;
        const n: Notice = {
          runId,
          askId,
          key: `answer:${runId}`,
          agentName: answer.spokesperson?.agentName ?? d?.stages.find((s) => s.isAggregator)?.agentName ?? d?.stages[0]?.agentName ?? "エージェント",
          headline: noticeHeadline({ askText: request, answer, stages: d?.stages }),
          lead: noticeLead(answer.conclusion),
          request,
          answer,
        };
        setToasts((t) => [n, ...t.filter((x) => x.runId !== runId)].slice(0, MAX_TOASTS));
        systemNotify(n, () => show(n));
      });
  });

  return (
    <>
      <div className="notices" aria-live="polite" aria-label="届いた知らせ">
        {questions.map((q) => (
          <div key={q.questionId} className="notice">
            <button
              type="button"
              className="notice-main"
              onClick={() => {
                dropQuestion(q.questionId);
                navigate(`/asks/${q.askId}`);
              }}
            >
              <Avatar name={q.agentName} mood="running" size={40} />
              <span className="notice-text">
                <span className="notice-head">
                  <span className="notice-who">{q.agentName}</span>
                  <span className="notice-headline">質問があります</span>
                </span>
                <span className="notice-lead">{q.text}</span>
              </span>
            </button>
            <button type="button" className="notice-close" aria-label="知らせを閉じる" onClick={() => dropQuestion(q.questionId)}>
              ×
            </button>
          </div>
        ))}
        {toasts.map((n) => (
          <Toast key={n.runId} n={n} onOpen={() => show(n)} onClose={() => dismiss(n.runId)} />
        ))}
      </div>
      {open && <NoticeSheet n={open} onClose={() => setOpen(null)} />}
    </>
  );
}

interface QuestionNotice {
  questionId: string;
  askId: string;
  agentName: string;
  text: string;
}

/** 質問もタブが裏にあるときだけブラウザの通知を出す。押すと依頼のページへ */
function systemNotifyQuestion(q: QuestionNotice): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted" || document.visibilityState === "visible") return;
  try {
    const sys = new Notification(`${q.agentName}：質問があります`, { body: q.text, tag: q.questionId });
    sys.onclick = () => {
      window.focus();
      navigate(`/asks/${q.askId}`);
      sys.close();
    };
  } catch {
    // Android の Chrome は new Notification を許さない。カードだけにする
  }
}

/** タブが裏にあるときだけ、ブラウザの通知を出す（表にいるならカードで足りる） */
function systemNotify(n: Notice, onClick: () => void): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted" || document.visibilityState === "visible") return;
  try {
    const sys = new Notification(`${n.agentName}：${n.headline}`, { body: n.lead, tag: n.runId });
    sys.onclick = () => {
      window.focus();
      onClick();
      sys.close();
    };
  } catch {
    // Android の Chrome は new Notification を許さない（Service Worker が要る）。カードだけにする
  }
}

function Toast({ n, onOpen, onClose }: { n: Notice; onOpen: () => void; onClose: () => void }) {
  const [paused, setPaused] = useState(false);
  // onClose は親の描画のたびに作り直される。タイマーは作り直しで止めず、最新の onClose を ref で呼ぶ
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (paused) return;
    const id = setTimeout(() => closeRef.current(), TOAST_MS);
    return () => clearTimeout(id);
  }, [paused]);

  return (
    <div className="notice" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      <button type="button" className="notice-main" onClick={onOpen}>
        <Avatar name={n.agentName} mood="done" size={40} />
        <span className="notice-text">
          <span className="notice-head">
            <span className="notice-who">{n.agentName}</span>
            <span className="notice-headline">{n.headline}</span>
          </span>
          {n.request && <span className="notice-request">「{n.request}」への回答</span>}
          {n.lead && <span className="notice-lead">{n.lead}</span>}
        </span>
      </button>
      <button type="button" className="notice-close" aria-label="知らせを閉じる" onClick={onClose}>
        ×
      </button>
    </div>
  );
}

function NoticeSheet({ n, onClose }: { n: Notice; onClose: () => void }) {
  const { online, refreshCounts } = useWorkspace();
  const titleId = useId();
  const sheetRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  useRestoreFocus();

  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else trapTab(e, sheetRef.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const { answer } = n;
  const points = noticePoints(answer.conclusion);
  const pending = answer.needsYou.pendingApprovals;

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.markChecked(n.key);
      refreshCounts();
      onClose();
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  };
  const detail = (hash = "") => {
    onClose();
    navigate(`/asks/${n.askId}${hash}`);
  };

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="sheet notice-sheet" ref={sheetRef} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="sheet-grip" aria-hidden="true" />
        <div className="notice-sheet-head">
          <Avatar name={n.agentName} mood="done" size={52} />
          <div>
            <p className="notice-who">{n.agentName}</p>
            <h2 id={titleId} className="sheet-title">
              {n.headline}
            </h2>
            {n.request && <p className="notice-request">「{n.request}」への回答</p>}
          </div>
        </div>
        <div className="notice-sheet-body">
          {all || points.length === 0 ? (
            <Markdown className="answer-text" text={answer.conclusion} />
          ) : (
            <>
              {n.lead && !points.includes(n.lead) && <p className="notice-sheet-lead">{n.lead}</p>}
              <ul className="notice-points">
                {points.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
              <button type="button" className="link quiet" onClick={() => setAll(true)}>
                全文を見る
              </button>
            </>
          )}
          {answer.memberLines.length > 0 && (
            <ul className="plain notice-members">
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
          {pending > 0 && (
            <button type="button" className="needs-you link" onClick={() => detail("#approvals")}>
              {answer.needsYou.line ?? `あなたの確認待ち：${pending}件`}
            </button>
          )}
          {answer.taintNote && <p className="muted">{answer.taintNote}</p>}
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="sheet-actions">
          <button type="button" className="btn" ref={firstRef} onClick={() => detail()}>
            くわしく
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !online} onClick={() => void check()}>
            {busy ? "片づけています…" : "見た"}
          </button>
        </div>
      </div>
    </>
  );
}
