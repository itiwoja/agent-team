// SCR-020：任せる（`/`）。真ん中の1文・例文・入力欄だけ（件数はヘッダー右、カレンダーの接続はメニュー）。頼むと「エージェント生成中…」→ 担当が1行ずつ現れる → 3秒で戻る
import { useCallback, useEffect, useReducer, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from "react";
import { api, describeError } from "../api";
import { Avatar } from "../components/Avatar";
import { askNoticePermission } from "../components/Notices";
import { GIVE_UP_MS, SHOW_MS, SLOW_MS, askCreatedAfterGiveUp, generationReducer, initialGen, isGenerationEvent, type GenState } from "../lib/generation";
import { readDraft, writeDraft } from "../lib/draft";
import { pickExamples, readPrefill, readPrepared } from "../lib/prefill";
import { Link, navigate, replaceUrl } from "../lib/router";
import { ArrowUpIcon } from "../ui/icons";
import { useWorkspace, useWorkspaceEvent } from "../workspace";

/** 入力欄の例文（A-96：固定の候補 10 個。毎回入れ替える） */
const EXAMPLES = [
  "在庫が減ったら発注して",
  "毎朝7時にニュースをまとめて",
  "仕入れ先のメールを読んで、在庫を見て、必要なら発注して",
  "来週の予定を確認して、重なっているものを教えて",
  "週に一度、依存関係の更新を調べて",
  "お客さんからの問い合わせメールを整理して",
  "今月の売上をまとめて、先月と比べて",
  "毎日18時に、今日の発注を一覧にして",
  "新しい注文が入ったら、店長に知らせて",
  "競合の値段を調べて、表にして",
];

export function Entrance() {
  const { killSwitchEngaged, online } = useWorkspace();
  const [state, dispatch] = useReducer(generationReducer, initialGen);
  // 書きかけの文はほかの画面へ移っても残す（lib/draft.ts。送ったら消える）
  const [text, setText] = useState(readDraft);
  useEffect(() => writeDraft(text), [text]);
  // 毎回ランダム。例文チップはプレースホルダーの例文と重ならないように選ぶ
  const [{ placeholder, chips }] = useState(() => {
    const [first = EXAMPLES[0] ?? ""] = pickExamples(EXAMPLES, 1);
    return { placeholder: `例：${first}`, chips: pickExamples(EXAMPLES, 3, [first]) };
  });
  const [paused, setPaused] = useState(false);
  // Google カレンダー・GitHub の接続の結果（/?connected=gcal|github・/?connect_error=…。読んだら URL を / に戻す）
  const [connectNote, setConnectNote] = useState<{ text: string; error: boolean } | null>(null);
  // 審査用のトークンで入った直後（`/?prepared=askId`。D-118）：用意した依頼が待っていることを知らせる（開くか閉じるまで残す）
  const [prepared, setPrepared] = useState<string | null>(null);
  const phaseRef = useRef(state.phase);
  phaseRef.current = state.phase;
  const askIdRef = useRef(state.askId);
  askIdRef.current = state.askId;
  const generationRef = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // `/?text=…` で開かれたら、その文を入力欄に入れてフォーカスし、URL を `/` に戻す（送りはしない）
  useEffect(() => {
    const pre = readPrefill(location.search);
    if (pre === null) return;
    replaceUrl("/");
    setText(pre);
    // 画面を移ったときの main へのフォーカス（親の effect は子より後に走る）に上書きされないよう、次のフレームで入れる
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  useEffect(() => {
    const id = readPrepared(location.search);
    if (id === null) return;
    replaceUrl("/");
    setPrepared(id);
  }, []);

  useEffect(() => {
    const p = new URLSearchParams(location.search);
    const connected = p.get("connected");
    const failed = p.get("connect_error");
    if (connected === null && failed === null) return;
    replaceUrl("/");
    if (connected === "gcal") setConnectNote({ text: "Google カレンダーをつなぎました", error: false });
    else if (connected === "github") setConnectNote({ text: "GitHub をつなぎました。リポジトリの依頼を出せます", error: false });
    else setConnectNote({ text: CONNECT_ERROR_TEXT[failed ?? "failed"] ?? "つなげませんでした。もう一度お試しください", error: true });
  }, []);
  // 知らせは数秒で消す（読み終えたら邪魔にしない）
  useEffect(() => {
    if (!connectNote) return;
    const id = setTimeout(() => setConnectNote(null), 6000);
    return () => clearTimeout(id);
  }, [connectNote]);

  // 依頼の事象（ask.*）。生成に関わる5種だけ畳み込む（ask.answered などは依頼のページ向けなので通さない）
  useWorkspaceEvent((type, data) => {
    if (!data || typeof data !== "object") return;
    const event = { ...(data as Record<string, unknown>), type };
    if (!isGenerationEvent(event)) return;
    dispatch({ type: "event", event });
  });

  // 10 秒・30 秒（生成中のあいだだけ。質問に答えている間は数えない）
  useEffect(() => {
    if (state.phase !== "generating") return;
    let cancelled = false;
    const generation = generationRef.current;
    const askId = state.askId;
    const slow = setTimeout(() => dispatch({ type: "slow" }), SLOW_MS);
    // 打ち切りの後も依頼はサーバーで作られ続けることがある。依頼の ID が分かっていて作られていれば、失敗にせず依頼のページへ進む
    const giveUp = setTimeout(() => {
      void askCreatedAfterGiveUp(askId, (id) => api.ask(id)).then((id) => {
        if (cancelled || generationRef.current !== generation || askIdRef.current !== askId) return;
        const p = phaseRef.current;
        if (id !== null && (p === "generating" || p === "question")) navigate(`/asks/${id}`);
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
    const id = setInterval(() => {
      api
        .ask(state.askId!)
        .then((detail) => dispatch({ type: "detail", detail }))
        .catch(() => undefined);
    }, 4000);
    return () => clearInterval(id);
  }, [state.phase, state.askId]);

  // 送った入力欄は生成中に消える。消えた要素からは blur が来ないので、送ったときのフォーカスで paused が立ったまま残る。
  // 編成を見せるときに、いまフォーカスが本当に入口の中にあるかで決め直す（無ければ 3 秒で戻る）
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.phase !== "shown") return;
    const active = document.activeElement;
    setPaused(active !== null && active !== document.body && rootRef.current?.contains(active) === true);
  }, [state.phase]);

  // 作り終えた編成は 3 秒見せて入口に戻る（読んでいる間・触っている間は止める）
  useEffect(() => {
    if (state.phase !== "shown" || paused) return;
    const id = setTimeout(() => dispatch({ type: "reset" }), SHOW_MS);
    return () => clearTimeout(id);
  }, [state.phase, paused]);

  // 作れなかったら、送った文を入力欄に戻す
  useEffect(() => {
    if (state.phase === "failed") setText(state.sentText);
  }, [state.phase, state.sentText]);

  const submit = useCallback(
    async (value: string) => {
      const t = value.trim();
      if (!t) return;
      // 終わったら知らせる（タブが裏にあるときのブラウザの通知）。頼んだ操作に合わせて1度だけ許可を聞く
      askNoticePermission();
      generationRef.current += 1;
      setText("");
      dispatch({ type: "submit", text: t });
      try {
        const { ask } = await api.createAsk(t);
        dispatch({ type: "accepted", ask });
      } catch (e) {
        dispatch({ type: "error", message: describeError(e) });
      }
    },
    [],
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

  const disabled = killSwitchEngaged || !online;
  const idle = state.phase === "idle" || state.phase === "failed";
  // 例文は、入力欄が空で、頼める状態のときだけ出す
  const showExamples = idle && !disabled && text.trim() === "";

  return (
    <div className="entrance" ref={rootRef} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      <div className="entrance-body">
        <Center state={state} killSwitchEngaged={killSwitchEngaged} onAnswer={answer} />
        {connectNote && (
          <p className={`entrance-note connect-note${connectNote.error ? " error" : " muted"}`} role="status">
            {connectNote.text}
          </p>
        )}
        {prepared && idle && (
          <div className="entrance-note prepared-note" role="status">
            <p className="prepared-note-text">用意した依頼（受信箱係 → 仕入れ係）が待っています。送る前の確認が1件あります</p>
            <div className="prepared-note-actions">
              <Link to={`/asks/${encodeURIComponent(prepared)}`} className="btn btn-primary">
                依頼のページを開く
              </Link>
              <button type="button" className="btn btn-ghost" onClick={() => setPrepared(null)}>
                あとで
              </button>
            </div>
          </div>
        )}
        {showExamples && (
          <Examples
            examples={chips}
            onPick={(ex) => {
              setText(ex);
              inputRef.current?.focus();
            }}
          />
        )}
        {idle && (
          <>
            {state.phase === "failed" && (
              <p className="error entrance-note" role="alert">
                {state.message}
              </p>
            )}
            {!online && !killSwitchEngaged && <p className="muted entrance-note">つながっていません</p>}
          </>
        )}
      </div>
      {idle && (
        <div className="dock">
          <Composer value={text} onChange={setText} onSubmit={submit} disabled={disabled} placeholder={placeholder} inputRef={inputRef} />
        </div>
      )}
    </div>
  );
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

/** 頼み方の例（タップで入力欄に入れる。送りはしない） */
function Examples({ examples, onPick }: { examples: string[]; onPick: (example: string) => void }) {
  return (
    <div className="entrance-examples" role="group" aria-label="頼み方の例">
      {examples.map((ex) => (
        <button key={ex} type="button" className="chip entrance-example" onClick={() => onPick(ex)}>
          {ex}
        </button>
      ))}
    </div>
  );
}

function Center({ state, killSwitchEngaged, onAnswer }: { state: GenState; killSwitchEngaged: boolean; onAnswer: (a: { choiceId: string } | { text: string }) => void }) {
  if (killSwitchEngaged && (state.phase === "idle" || state.phase === "failed")) return <h1 className="hero entrance-title">全部止めています</h1>;
  switch (state.phase) {
    case "idle":
    case "failed":
      return <h1 className="hero entrance-title">頼むだけで、あなたの担当が生まれる</h1>;
    case "generating":
      return (
        <section className="gen">
          <Egg />
          <div aria-live="polite" className="gen-live">
            <h1 className="hero entrance-title">エージェント生成中…</h1>
            {state.slow && <p className="muted entrance-note">まだ考えています</p>}
          </div>
        </section>
      );
    case "question":
      return state.question ? <Question q={state.question} onAnswer={onAnswer} /> : null;
    case "shown":
      return <Formation state={state} />;
  }
}

/** 生成中のたまご（ゆらゆら揺れて、ひびが入る。編成ができると担当が生まれる） */
function Egg() {
  return (
    <span className="gen-egg" aria-hidden="true">
      <svg viewBox="0 0 64 72" width="72" height="81" focusable="false">
        <ellipse cx="32" cy="68" rx="16" ry="2.6" fill="currentColor" opacity="0.1" />
        <g className="gen-egg-body">
          <path d="M32 6C46 6 54 30 54 44C54 58 44 66 32 66S10 58 10 44C10 30 18 6 32 6Z" fill="#fff7e6" stroke="#d9b98a" strokeWidth="1.8" />
          <circle cx="22" cy="40" r="3.4" fill="#ffd2a8" />
          <circle cx="40" cy="28" r="2.6" fill="#ffd2a8" />
          <circle cx="42" cy="50" r="3.8" fill="#ffd2a8" />
          <path className="gen-egg-crack" d="M18 34L24 30L28 36L34 29L39 35L45 31" fill="none" stroke="#b8925c" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      </svg>
    </span>
  );
}

function Formation({ state }: { state: GenState }) {
  const body = (
    <>
      <ul className="gen-members" aria-label="できた編成">
        {state.members.map((m, i) => (
          <li key={m.key} style={{ ["--i" as string]: i }} className="gen-member">
            <Avatar name={m.agentName} mood={m.isNew ? "done" : "idle"} size={52} className="avatar-pop" />
            <div>
              <h2 className="gen-name">{m.agentName}</h2>
              <h3 className="gen-summary">{m.summary}</h3>
              <p className="muted">{m.isNew ? "新しく作りました" : "いつもの担当"}</p>
            </div>
          </li>
        ))}
      </ul>
      {state.shapeLine && (
        <p className="gen-shape" style={{ ["--i" as string]: state.members.length }}>
          {state.shapeLine}
        </p>
      )}
    </>
  );
  return (
    <section aria-live="polite" className="gen">
      <h1 className="sr-only">エージェントができました</h1>
      {state.askId ? (
        <Link to={`/asks/${state.askId}`} className="gen-link">
          {body}
          <span className="sr-only">この依頼のページを開く</span>
        </Link>
      ) : (
        body
      )}
    </section>
  );
}

function Question({ q, onAnswer }: { q: NonNullable<GenState["question"]>; onAnswer: (a: { choiceId: string } | { text: string }) => void }) {
  const [writing, setWriting] = useState(false);
  const [own, setOwn] = useState("");
  const noChoices = q.choices.length === 0;
  return (
    <section className="gen question" aria-live="polite">
      <h1 className="hero entrance-title question-text">{q.text}</h1>
      <div className="choices">
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
          <label htmlFor="own-answer" className="sr-only">
            答えを書く
          </label>
          <input id="own-answer" value={own} onChange={(e) => setOwn(e.target.value)} autoFocus maxLength={2000} />
          <button type="submit" className="btn btn-primary" disabled={!own.trim()}>
            送る
          </button>
        </form>
      )}
    </section>
  );
}

function Composer({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  disabled: boolean;
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
    // 日本語の変換中の Enter は送らない
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    // 全端末共通：Enter で送る・Shift+Enter で改行（チャット UI と同じ）
    if (e.shiftKey) return;
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
        任せたい仕事
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
        onFocus={() => window.scrollTo(0, 0)}
      />
      {/* 送るボタンは常に矢印。空のときは薄い ghost で押せない（F-011：マイクに見せない） */}
      <button type="submit" className={`round-btn ${empty ? "ghost" : "solid"}`} aria-label="頼む" disabled={disabled || empty}>
        <ArrowUpIcon />
      </button>
    </form>
  );
}
