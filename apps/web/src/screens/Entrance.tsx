// SCR-020：入口（`/`）。真ん中の1文・例文・入力欄だけ（件数はヘッダー右、カレンダーの接続はメニュー）。頼むと「担当を作っています…」→ 担当が1行ずつ現れる → 依頼のページ（/asks/:id）へ移る
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from "react";
import { Egg, GenFormation } from "../components/GenStage";
import { enterAskDelay, type GenState } from "../lib/generation";
import { readDraft, writeDraft } from "../lib/draft";
import { pickExamples, readPrefill } from "../lib/prefill";
import { navigate, replaceUrl } from "../lib/router";
import { ArrowUpIcon } from "../ui/icons";
import { useAskGeneration } from "../lib/useAskGeneration";
import { useWorkspace } from "../workspace";

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

export function Entrance() {
  const { online } = useWorkspace();
  const { state, submit: send, answer, reset } = useAskGeneration();
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

  // 送った入力欄は生成中に消える。消えた要素からは blur が来ないので、送ったときのフォーカスで paused が立ったまま残る。
  // 編成を見せるときに、いまフォーカスが本当に入口の中にあるかで決め直す（無ければ 3 秒で戻る）
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.phase !== "shown") return;
    const active = document.activeElement;
    setPaused(active !== null && active !== document.body && rootRef.current?.contains(active) === true);
  }, [state.phase]);

  // 作り終えた編成を少し見せて、依頼のページへ移る（読んでいる間・触っている間は止める）
  useEffect(() => {
    if (state.phase !== "shown" || paused || !state.askId) return;
    const askId = state.askId;
    const id = setTimeout(() => {
      navigate(`/asks/${askId}`);
      reset();
    }, enterAskDelay(state.members.length));
    return () => clearTimeout(id);
  }, [state.phase, state.askId, state.members.length, paused, reset]);

  // 作れなかったら、送った文を入力欄に戻す
  useEffect(() => {
    if (state.phase === "failed") setText(state.sentText);
  }, [state.phase, state.sentText]);

  const submit = (value: string) => {
    if (send(value)) setText("");
  };

  const disabled = !online;
  const idle = state.phase === "idle" || state.phase === "failed";
  // 例文は、入力欄が空で、頼める状態のときだけ出す
  const showExamples = idle && !disabled && text.trim() === "";

  return (
    <div className="entrance" ref={rootRef} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      <div className="entrance-body">
        <Center state={state} onAnswer={answer} />
        {connectNote && (
          <p className={`entrance-note connect-note${connectNote.error ? " error" : " muted"}`} role="status">
            {connectNote.text}
          </p>
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
            {!online && <p className="muted entrance-note">つながっていません</p>}
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

function Center({ state, onAnswer }: { state: GenState; onAnswer: (a: { choiceId: string } | { text: string }) => void }) {
  switch (state.phase) {
    case "idle":
    case "failed":
      return <h1 className="hero entrance-title">頼むだけで、あなたの担当が生まれる</h1>;
    case "generating":
      return (
        <section className="gen">
          <Egg />
          <div aria-live="polite" className="gen-live">
            <h1 className="hero entrance-title">担当を作っています…</h1>
            {state.slow && <p className="muted entrance-note">まだ考えています</p>}
          </div>
        </section>
      );
    case "question":
      return state.question ? <Question q={state.question} onAnswer={onAnswer} /> : null;
    case "shown":
      return <GenFormation state={state} />;
  }
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
