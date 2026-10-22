// SCR-019 の行（SCR-021 の「送る前の確認」と共有する部品）。種類は3つ：報告（○）・送る前の確認（○送る＝5秒の取り消し猶予）・質問（選択肢）
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Avatar } from "./Avatar";
import { Markdown } from "./Markdown";
import {
  ApiError,
  api,
  describeError,
  type ApprovalItem,
  type CalendarCard,
  type GithubCard,
  type CheckItem,
  type QuestionItem,
  type ReportItem,
} from "../api";
import { Link, navigate } from "../lib/router";
import { argLabel } from "../lib/argLabels";
import { requestKey } from "../lib/requestKey";
import { askRetryAction, reaskKeyFor, retryPlanFor } from "../lib/retry";
import { splitEmphasis } from "../lib/text";
import { undoStore, useUndo } from "../lib/undo";
import { Chevron } from "../ui/icons";
import { useWorkspace } from "../workspace";

export interface RowHandlers {
  /** 行が片づいた（○・承認・回答のあと）。一覧から隠す */
  onGone: (key: string) => void;
  /** 隠した行を戻す（○ がサーバーで失敗したとき）。理由を渡すと一覧の側で持つ。渡されなければ取り直し（onReload）だけ */
  onBack?: (key: string, message?: string) => void;
  /** 一覧の側に持っている失敗の理由（行が作り直されても出る） */
  failure?: string;
  /** 取り直す */
  onReload: () => void;
}

export const rowDomId = (key: string): string =>
  `row-${key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

/** フォーカスが body に落ちている・この行の中にある（＝行が消えると行き場がなくなる）ときだけ true */
const focusIsIn = (row: Element | null): boolean => {
  const active = document.activeElement;
  return !active || active === document.body || (row !== null && row.contains(active));
};

/**
 * 行が消える前に、フォーカスの行き先を決めて移す（キーボードで ○ を押したあと body に落ちないように）。
 * 次の行の .row-main（押せるもの）があればそれへ、なければ見出し（tabIndex={-1} の h1）へ。
 * 利用者がすでに別の所へ移っていれば何もしない。見出しが無い画面（SCR-021）でも次の行がなければ何もしない
 */
export function focusAfterGone(key: string): void {
  const row = document.getElementById(rowDomId(key));
  if (!row || !focusIsIn(row)) return;
  let next = row.nextElementSibling;
  while (next) {
    const main = next.querySelector<HTMLElement>("button.row-main");
    if (main && !main.hasAttribute("disabled")) {
      main.focus();
      return;
    }
    next = next.nextElementSibling;
  }
  row
    .closest(".check-page")
    ?.querySelector<HTMLElement>("h1[tabindex]")
    ?.focus();
}

export function CheckRow({ item, ...h }: { item: CheckItem } & RowHandlers) {
  switch (item.kind) {
    case "approval":
      return <ApprovalRow item={item} {...h} />;
    case "question":
      return <QuestionRow item={item} {...h} />;
    case "report":
      return <ReportRow item={item} {...h} />;
  }
}

/** 使えない条件：全部止めている・オフライン（○ を無効にする） */
function useBlocked(): boolean {
  const { killSwitchEngaged, online } = useWorkspace();
  return killSwitchEngaged || !online;
}

/** ○：48px のタップ領域に 28px の輪。送る前の確認は下に「送る」「許可」を文字でも出す */
function CheckButton({
  label,
  verb,
  onClick,
  disabled,
}: {
  label: string;
  verb?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={verb ? "check gate" : "check"}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="check-ring" aria-hidden="true" />
      {verb && (
        <span className="check-label" aria-hidden="true">
          {verb}
        </span>
      )}
    </button>
  );
}

function Toggle({
  open,
  onToggle,
  controls,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  controls: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="row-main"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
    >
      {children}
    </button>
  );
}

/** 行の種類の札（題の上に小さく出す。一覧で「何の行か」を先に見分けられるように） */
function KindTag({ tone, children }: { tone: "report" | "failed" | "ask" | "gate" | "wait"; children: ReactNode }) {
  return <span className={`row-kind ${tone}`}>{children}</span>;
}

/** 本文の頭が題と同じ文なら、開いたときに同じ文を2回見せないよう落とす */
function dropLeadingTitle(body: string, title: string): string {
  const b = body.trimStart();
  return b.startsWith(title) ? b.slice(title.length).trimStart() : body;
}

/**
 * 長い本文は畳んでおき、「全文を見る」で広げる（一覧の中で次の行が遠くならないように）。
 * footer（「この依頼のページを開く」）は「全文を見る」と同じ行に並べる
 */
function Clamp({ children, footer }: { children?: ReactNode; footer?: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  const [full, setFull] = useState(false);
  useEffect(() => {
    const el = box.current;
    // 広げている間は測らない（測ると溢れていないことになり「たたむ」が消える）
    if (el && !full) setOver(el.scrollHeight > el.clientHeight + 4);
  }, [children, full]);
  return (
    <>
      {children && (
        <div ref={box} className={full ? "clamp" : over ? "clamp is-clamped" : "clamp is-short"}>
          {children}
        </div>
      )}
      {(over || footer) && (
        <div className="row-foot">
          {over && (
            <button type="button" className="link quiet clamp-toggle" aria-expanded={full} onClick={() => setFull((v) => !v)}>
              {full ? "たたむ" : "全文を見る"}
            </button>
          )}
          {footer}
        </div>
      )}
    </>
  );
}

// ---- 報告 ----

function ReportRow({
  item,
  onGone,
  onBack,
  failure,
  onReload,
}: { item: ReportItem } & RowHandlers) {
  const blocked = useBlocked();
  const [open, setOpen] = useState(item.opened);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const detailId = useId();
  const { entry, remaining } = useUndo(item.key);
  const undoBtn = useRef<HTMLButtonElement>(null);
  const pendingRow = useRef<HTMLLIElement>(null);
  // 行の中の理由（やり直しの失敗）と、一覧の側の理由（○ の失敗）のうち、新しい方を出す
  const shownError = error ?? failure ?? null;

  // ○ で行が「済みにします… [取り消す]」に置き換わって ○ が消える。承認の行と同じく、
  // フォーカスを「取り消す」へ移し、取り消したら行の本体へ戻す。済みにできなかったときは失敗の表示を消して行を戻す
  const status = entry?.status;
  const prevStatus = useRef(status);
  useEffect(() => {
    const was = prevStatus.current;
    prevStatus.current = status;
    if (status === "pending") undoBtn.current?.focus();
    else if (status === "sending" && focusIsIn(pendingRow.current)) pendingRow.current?.focus();
    else if (status === undefined && was === "pending" && focusIsIn(null))
      document
        .getElementById(rowDomId(item.key))
        ?.querySelector<HTMLElement>("button.row-main")
        ?.focus();
    else if (status === "failed") undoStore.dismiss(item.key);
  }, [status, item.key]);

  if (status === "done") return null;

  // ○：すぐには送らず、5秒のうちは取り消せる。過ぎたら行を片づけて既読を送る
  const check = () => {
    setError(null);
    undoStore.start(item.key, async () => {
      focusAfterGone(item.key);
      onGone(item.key);
      try {
        await api.markChecked(item.key);
      } catch (e) {
        // 消せなかった行は戻し、理由を一覧の側に持たせて行に出す（行は戻すと作り直されるので、行の中の state では消える）
        const message = describeError(e);
        if (onBack) onBack(item.key, message);
        else setError(message);
        onReload();
        throw new Error(message);
      }
    });
  };
  // 失敗は札で示すので、題の頭の「失敗：」は落とす
  const title = item.failed ? item.title.replace(/^失敗[：:]\s*/, "") : item.title;

  // 失敗の行の「やり直す」：依頼は止まった段から再開か頼み直す
  const retryPlan = retryPlanFor(item);
  const retry = async () => {
    const askId = item.link.askId;
    if (!retryPlan || !askId) return;
    setError(null);
    setRetrying(true);
    let next = askId;
    try {
      const detail = await api.ask(askId);
      const action = askRetryAction(detail);
      if (action === "resume") await api.resumeAsk(askId, "retry");
      // 同じ依頼の失敗の行が複数あっても、同じキーなので依頼は1つだけ作られる（2回目は最初の依頼の応答が返る）
      else if (action === "reask") next = (await api.createAsk(detail.ask.text, await reaskKeyFor(askId))).ask.id;
      // open：元の依頼がまだ動いている（作り直すと二重になる）ので、その依頼のページを開くだけ
    } catch (e) {
      setRetrying(false);
      setError(describeError(e));
      return;
    }
    // やり直しが通ったので、○ と同じく行を片づけてから、その依頼のページへ移す
    focusAfterGone(item.key);
    onGone(item.key);
    // 行を消せなくても、やり直しはもう通っているので戻さずに移る（行を戻すと、もう一度押して二重に始めてしまう）
    await api.markChecked(item.key).catch(() => undefined);
    navigate(`/asks/${next}`);
  };

  const kind = item.reportKind === "evolution" ? "育った" : "報告";
  const body = item.body ? dropLeadingTitle(item.body, item.title) : null;
  const hasBody = Boolean(body) || item.lines.length > 0;
  const agentLink = item.link.agentId ? (
    <Link to={`/agents#${item.link.agentId}`} className="row-link">
      この担当を開く
      <Chevron dir="right" size={14} />
    </Link>
  ) : null;
  const askLink = agentLink ?? (item.link.askId ? (
    <Link to={`/asks/${item.link.askId}`} className="row-link">
      この依頼のページを開く
      <Chevron dir="right" size={14} />
    </Link>
  ) : null);

  if (status === "pending" || status === "sending") {
    // ○ を押した直後：行の中で置き換わる。読み上げは状態の文だけ（残り秒は毎秒変わるので aria-hidden）
    return (
      <li className="row is-pending" id={rowDomId(item.key)} ref={pendingRow} tabIndex={-1}>
        <div className="row-main">
          <div className="row-title">{title}</div>
          <div className="undo">
            <span role="status">{status === "pending" ? "済みにします…" : "済みにしています"}</span>
            {status === "pending" && (
              <button
                type="button"
                className="undo-btn"
                aria-label="取り消す"
                ref={undoBtn}
                onClick={() => undoStore.cancel(item.key)}
              >
                取り消す{" "}
                <span className="undo-sec" aria-hidden="true">
                  {remaining}
                </span>
              </button>
            )}
          </div>
        </div>
      </li>
    );
  }

  return (
    <li className={open ? "row is-open" : "row"} id={rowDomId(item.key)}>
      <div className="row-top">
        <Toggle
          open={open}
          onToggle={() => setOpen((v) => !v)}
          controls={detailId}
        >
          <span className="row-tags">
            <KindTag tone={item.failed ? "failed" : "report"}>{item.failed ? "失敗" : kind}</KindTag>
            {item.dryRun && <KindTag tone="wait">試し・送っていません</KindTag>}
          </span>
          <span className={item.failed ? "row-title failed" : "row-title"}>
            {title}
          </span>
          {item.request && <span className="row-meta row-request">「{item.request}」への回答</span>}
          {item.subtitle && (
            <span className="row-meta row-agent">
              {item.agent && <Avatar name={item.agent.name} mood={item.failed ? "failed" : "done"} size={22} />}
              {item.subtitle}
            </span>
          )}
        </Toggle>
        <CheckButton
          label={`チェックする：${item.title}`}
          onClick={check}
          disabled={blocked || retrying}
        />
      </div>
      {retryPlan && (
        <div className="row-retry">
          <button
            type="button"
            className="btn btn-retry"
            aria-label={`やり直す：${title}`}
            disabled={blocked || retrying}
            onClick={() => void retry()}
          >
            {retrying ? "やり直しています…" : "やり直す"}
          </button>
        </div>
      )}
      {open && (
        <div className="row-detail" id={detailId}>
          {item.dryRun && (
            <p className="dryrun" role="note">
              試し実行 · 外部作用は行いません
            </p>
          )}
          {(hasBody || askLink) && (
            <Clamp footer={askLink}>
              {hasBody && (
                <>
                  {body && <Markdown text={body} />}
                  {item.lines.length > 0 && (
                    <ul className="detail-lines">
                      {item.lines.map((l, i) => (
                        <li key={i} className="pre">
                          {l}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </Clamp>
          )}
        </div>
      )}
      {shownError && (
        <p className="error" role="alert">
          {shownError}
        </p>
      )}
    </li>
  );
}

// ---- 質問 ----

function QuestionRow({
  item,
  onGone,
  onReload,
}: { item: QuestionItem } & RowHandlers) {
  const blocked = useBlocked();
  const [open, setOpen] = useState(item.opened);
  const [writing, setWriting] = useState(false);
  const [own, setOwn] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const detailId = useId();
  const q = item.question;

  const send = async (a: { choiceId: string } | { text: string }) => {
    setBusy(true);
    setError(null);
    try {
      if (item.source === "unknown_outcome" && item.intentId) {
        await api.resolveUnknownOutcome(
          item.intentId,
          "choiceId" in a ? a.choiceId : a.text,
        );
      } else {
        // ask_question:<askId>（asks/contract.ts の API-073）
        const askId = item.askId ?? item.key.split(":")[1] ?? "";
        await api.answerAsk(askId, a);
      }
      focusAfterGone(item.key);
      onGone(item.key);
      onReload();
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  };

  return (
    <li className={open ? "row is-open" : "row"} id={rowDomId(item.key)}>
      <div className="row-top">
        <Toggle
          open={open}
          onToggle={() => setOpen((v) => !v)}
          controls={detailId}
        >
          <span className="row-tags">
            <KindTag tone="ask">質問</KindTag>
          </span>
          <span className="row-title">{q.text || item.title}</span>
          {item.agent && (
            <span className="row-meta row-agent">
              <Avatar name={item.agent.name} mood="approval" size={22} />
              {item.agent.name}
            </span>
          )}
        </Toggle>
      </div>
      <div className="choices">
        {q.choices.slice(0, 4).map((c) => (
          <button
            key={c.id}
            type="button"
            className="choice"
            disabled={blocked || busy}
            onClick={() => void send({ choiceId: c.id })}
          >
            {c.label}
          </button>
        ))}
        {q.allowFreeText && !writing && (
          <button
            type="button"
            className="link quiet"
            disabled={blocked || busy}
            onClick={() => setWriting(true)}
          >
            自分で書く
          </button>
        )}
      </div>
      {writing && (
        <form
          className="free"
          onSubmit={(e) => {
            e.preventDefault();
            if (own.trim()) void send({ text: own.trim() });
          }}
        >
          <label htmlFor={`${detailId}-own`} className="sr-only">
            答えを書く
          </label>
          <input
            id={`${detailId}-own`}
            value={own}
            onChange={(e) => setOwn(e.target.value)}
            placeholder="答えを書く"
            autoFocus
            maxLength={2000}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={blocked || busy || !own.trim()}
          >
            答える
          </button>
        </form>
      )}
      {open && (
        <div className="row-detail" id={detailId}>
          <p className="muted">{item.reason}</p>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

// ---- 送る前の確認 ----

/**
 * 予定の登録の確認（16 §3.7）：題名（太字）・日時・場所の小さな札。招待する人は強調し、招待メールは送らない一文を添える。
 * 実行したあとの「カレンダーで開く」は、行が消えたあとの結果を画面が受け取らないので出さない
 */
function CalendarCardView({ card }: { card: CalendarCard }) {
  return (
    <div className="gcal-card">
      {card.title && <p className="gcal-title">{card.title}</p>}
      {card.when && <p className="gcal-when">{card.when}</p>}
      {card.location && <p className="gcal-where">{card.location}</p>}
      {card.attendees.length > 0 && (
        <p className="gcal-people">
          <span className="gcal-people-label">招待</span>
          {card.attendees.join("、")}
        </p>
      )}
      {card.inviteNote && <p className="gcal-invite-note">{card.inviteNote}</p>}
    </div>
  );
}

/** GitHub の書き込みの確認カード（18 §3.7）。main への直接の書き込みは一文で目立たせる */
function GithubCardView({ card }: { card: GithubCard }) {
  return (
    <div className="gcal-card">
      {card.repo && <p className="gcal-title">{card.repo}</p>}
      {card.kind === "push_commit" ? (
        <p className="gcal-when">ブランチ：{card.branch ?? "（不明）"}{card.base ? `（${card.base} から作る）` : ""}</p>
      ) : (
        <p className="gcal-when">
          {card.branch ?? "（不明）"} → {card.base ?? "既定のブランチ"}
        </p>
      )}
      {card.files.length > 0 && (
        <p className="gcal-people">
          <span className="gcal-people-label">書く</span>
          {card.files.join("、")}
        </p>
      )}
      {card.deletes.length > 0 && (
        <p className="gcal-people">
          <span className="gcal-people-label">消す</span>
          {card.deletes.join("、")}
        </p>
      )}
      {card.protectedNote && <p className="gcal-invite-note error">{card.protectedNote}</p>}
    </div>
  );
}

function ApprovalRow({
  item,
  onGone,
  onReload,
}: { item: ApprovalItem } & RowHandlers) {
  const a = item.approval;
  const blocked = useBlocked();
  const { entry, remaining } = useUndo(item.key);
  const [open, setOpen] = useState(item.opened);
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState("");
  const [remembering, setRemembering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const detailId = useId();
  const undoBtn = useRef<HTMLButtonElement>(null);
  const pendingRow = useRef<HTMLLIElement>(null);

  // 通知から来た行（?item=）は開いた状態にする
  useEffect(() => {
    if (item.opened) setOpen(true);
  }, [item.opened]);

  // キーボードで ○ を押すと行が「送ります… [取り消す]」に置き換わって ○ が消える。
  // フォーカスを「取り消す」へ移し、5秒のうちに取り消せるようにする（F-015）。送っている間は行（tabIndex=-1）に留める
  const status = entry?.status;
  useEffect(() => {
    if (status === "pending") undoBtn.current?.focus();
    else if (status === "sending" && focusIsIn(pendingRow.current)) pendingRow.current?.focus();
    else if (status === "failed" && focusIsIn(null))
      document
        .getElementById(rowDomId(item.key))
        ?.querySelector<HTMLElement>("button.row-main")
        ?.focus();
  }, [status, item.key]);

  if (entry?.status === "done") return null;

  /** 画面に出していた intentHash を付けて承認する（見た内容と承認がずれない：ADR-005） */
  const approve = () => {
    const intentHash = a.intentHash;
    try {
      const key = requestKey();
      undoStore.start(item.key, async () => {
        try {
          await api.decide(a.id, { decision: "approve", intentHash }, key);
          focusAfterGone(item.key);
          onGone(item.key);
          onReload();
        } catch (e) {
          // 内容が変わった・もう決まっている：行を取り直す
          if (
            e instanceof ApiError &&
            (e.code === "INTENT_CHANGED" || e.code === "APPROVAL_NOT_PENDING")
          )
            onReload();
          throw new Error(describeError(e));
        }
      });
    } catch (e) {
      // 鍵が作れないなど、送る前に失敗したときは行の中に理由を出す（押しても無反応にしない）
      setError(describeError(e));
    }
  };

  const decide = async (body: {
    decision: "approve" | "reject";
    comment?: string;
    remember?: boolean;
    rememberFixedHash?: string;
  }) => {
    setBusy(true);
    setError(null);
    try {
      await api.decide(a.id, { ...body, intentHash: a.intentHash }, requestKey());
      focusAfterGone(item.key);
      onGone(item.key);
      onReload();
    } catch (e) {
      setError(describeError(e));
      if (
        e instanceof ApiError &&
        (e.code === "INTENT_CHANGED" || e.code === "APPROVAL_NOT_PENDING")
      )
        onReload();
      setBusy(false);
    }
  };

  const reason = a.openReason;
  const pending = entry?.status === "pending" || entry?.status === "sending";
  // widen（できることが増える）の確認は送るのではなく「許可」（ask-and-check.md §行の種類）
  const widen = reason?.code === "widen";
  const verb = widen ? "許可" : "送る";

  if (pending) {
    // ○ を押した直後：行の中で置き換わる。読み上げは状態の文だけ（残り秒は毎秒変わるので aria-hidden）
    const stateText =
      entry?.status === "pending"
        ? widen
          ? "許可します…"
          : "送ります…"
        : widen
          ? "許可しています"
          : "送っています";
    return (
      <li
        className="row is-pending"
        id={rowDomId(item.key)}
        ref={pendingRow}
        tabIndex={-1}
      >
        <div className="row-main">
          <div className="row-title">{item.title}</div>
          <div className="undo">
            <span role="status">{stateText}</span>
            {entry?.status === "pending" && (
              <button
                type="button"
                className="undo-btn"
                aria-label="取り消す"
                ref={undoBtn}
                onClick={() => undoStore.cancel(item.key)}
              >
                取り消す{" "}
                <span className="undo-sec" aria-hidden="true">
                  {remaining}
                </span>
              </button>
            )}
          </div>
        </div>
      </li>
    );
  }

  const emphasized = reason
    ? splitEmphasis(reason.text, reason.emphasis)
    : null;
  const meta = a.canDecide
    ? (item.agent?.name ?? "")
    : `${item.agent?.name ?? ""}${item.agent ? " · " : ""}${a.approvers.length > 0 ? `${a.approvers.map((x) => x.name).join("、")}さん` : "承認者"}の確認待ち`;
  return (
    <li className={open ? "row is-open" : "row"} id={rowDomId(item.key)}>
      {reason && (
        <p className="reason">
          {emphasized ? (
            <>
              {emphasized.before}
              <strong>{emphasized.strong}</strong>
              {emphasized.after}
            </>
          ) : (
            reason.text
          )}
        </p>
      )}
      <div className="row-top">
        <Toggle
          open={open}
          onToggle={() => setOpen((v) => !v)}
          controls={detailId}
        >
          <span className="row-tags">
            <KindTag tone={a.canDecide ? "gate" : "wait"}>
              {a.canDecide ? (widen ? "許可の確認" : "送る前の確認") : "確認待ち"}
            </KindTag>
          </span>
          <span className="row-title">{item.title}</span>
          {item.subtitle && (
            <span className="row-dest">
              <span aria-hidden="true">→ </span>
              {item.subtitle}
            </span>
          )}
          {!open && !reason && a.taintNote && (
            <span className="row-meta">{a.taintNote}</span>
          )}
          <span className="row-meta row-agent">
            {item.agent && <Avatar name={item.agent.name} mood={a.canDecide ? "approval" : "waiting"} size={22} />}
            {meta}
          </span>
        </Toggle>
        {a.canDecide && (
          <CheckButton
            label={`${verb}：${item.title}`}
            verb={verb}
            onClick={approve}
            disabled={blocked || busy}
          />
        )}
      </div>
      {a.calendar && <CalendarCardView card={a.calendar} />}
      {a.github && <GithubCardView card={a.github} />}
        {a.canDecide && !rejecting && !remembering && (
          <div className="detail-actions">
            <button
              type="button"
              className="link quiet"
              onClick={() => setRejecting(true)}
              disabled={blocked || busy}
            >
              送らない
            </button>
            {a.remember.offered && (
              <button
                type="button"
                className="link quiet"
                onClick={() => setRemembering(true)}
                disabled={blocked || busy}
              >
                以後も許可
              </button>
            )}
          </div>
        )}
        {rejecting && (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void decide({
                decision: "reject",
                ...(comment.trim() ? { comment: comment.trim() } : {}),
              });
            }}
          >
            <label htmlFor={`${detailId}-why`}>理由（任意）</label>
            <input
              id={`${detailId}-why`}
              value={comment}
              maxLength={1000}
              onChange={(e) => setComment(e.target.value)}
              autoFocus
            />
            <div className="inline-actions">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={blocked || busy}
              >
                送らない
              </button>
              <button
                type="button"
                className="link quiet"
                onClick={() => setRejecting(false)}
              >
                やめる
              </button>
            </div>
          </form>
        )}
        {remembering && a.remember.fixedHash && (
          <div className="inline-form">
            <p className="row-title">この内容で固定して許可しますか？</p>
            <ul className="plain">
              {a.remember.fixed.map((f) => (
                <li key={f.arg}>
                  <span className="muted">{argLabel(f.arg)}</span>{" "}
                  {f.label ? `${f.label}（${f.text}）` : f.text}
                </li>
              ))}
            </ul>
            <p className="muted small">
              次からは、これと同じ送り先・内容なら確認なしで送ります。
            </p>
            {a.remember.taintedOrigin && (
              <p className="small" role="note">
                外部の内容を読んだ後の書き込みです。宛先と内容を確かめてから許可してください
              </p>
            )}
            <div className="inline-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={blocked || busy}
                onClick={() =>
                  void decide({
                    decision: "approve",
                    remember: true,
                    rememberFixedHash: a.remember.fixedHash ?? "",
                  })
                }
              >
                許可する
              </button>
              <button
                type="button"
                className="link quiet"
                onClick={() => setRemembering(false)}
              >
                やめる
              </button>
            </div>
          </div>
        )}
      {open && (
        <div className="row-detail" id={detailId}>
          <Detail item={item} />
        </div>
      )}
      {entry?.status === "failed" && entry.error && (
        <p className="error" role="alert">
          {entry.error}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/** SCR-007 の中身：宛先・中身・その他・汚染・ルールによる判定（開いたときだけ。送る・送らないの操作は開かなくても押せる） */
function Detail({ item }: { item: ApprovalItem }) {
  const a = item.approval;
  const section = (title: string, rows: typeof a.destination) =>
    rows.length > 0 && (
      <div className="detail-block">
        <p className="detail-head">{title}</p>
        <dl className="detail-kv">
          {rows.map((r) => (
            <div key={r.arg}>
              <dt>{argLabel(r.arg)}</dt>
              <dd className="pre">{r.label ? `${r.label}（${r.text}）` : r.text}</dd>
            </div>
          ))}
        </dl>
      </div>
    );
  return (
    <>
      {section("宛先", a.destination)}
      {section("中身", a.content)}
      {section("その他", a.options)}
      {a.taint.tainted && a.taint.sources.length > 0 && (
        <div className="detail-block">
          <p className="detail-head">外部の内容を含む</p>
          {a.taint.sources.map((s, i) => (
            <p key={i}>{s.text}</p>
          ))}
        </div>
      )}
      <div className="detail-block">
        <p className="detail-head">ルールによる判定</p>
        <p>{a.rule.text}</p>
      </div>
    </>
  );
}

