// 全画面共通の「頼む」：入口以外の画面で、右下の「＋ 頼む」から開く入力欄のシート。
// 送ると useAskGeneration で生成し、入口と同じたまご→担当が生まれる見せ方（GenStage）のあと、依頼のページへ移る（移る処理は呼び出し側＝Screens）。
// 書きかけの文は入口と同じ（lib/draft.ts）
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { GenState } from "../lib/generation";
import { readDraft, writeDraft } from "../lib/draft";
import type { AskGeneration } from "../lib/useAskGeneration";
import { useRestoreFocus } from "../lib/useRestoreFocus";
import { ArrowUpIcon } from "../ui/icons";
import { trapTab } from "../ui/trapTab";
import { Egg, GenFormation } from "./GenStage";

export function AskComposerSheet({ gen, onAskPage, disabled, onClose }: { gen: AskGeneration; onAskPage: boolean; disabled: boolean; onClose: () => void }) {
  const { state } = gen;
  const [text, setText] = useState(readDraft);
  const titleId = useId();
  const sheetRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useRestoreFocus();
  useEffect(() => writeDraft(text), [text]);

  // 作れなかったら、送った文を入力欄に戻す
  useEffect(() => {
    if (state.phase === "failed") setText(state.sentText);
  }, [state.phase, state.sentText]);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else trapTab(e, sheetRef.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const idle = state.phase === "idle" || state.phase === "failed";
  // 入力欄が消えたとき（送った・質問が来た）にフォーカスがシートの外へ落ちないよう、シート自体に戻す
  useEffect(() => {
    if (idle) inputRef.current?.focus();
    else sheetRef.current?.focus();
  }, [idle]);

  const send = () => {
    if (gen.submit(text)) setText("");
  };
  const empty = text.trim() === "";

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="sheet ask-sheet" ref={sheetRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="sheet-grip" aria-hidden="true" />
        <h2 id={titleId} className="sheet-title">
          {onAskPage ? "新しい依頼を頼む" : "頼む"}
        </h2>
        {onAskPage && <p className="muted ask-sheet-note">いま開いている依頼とは別の、新しい依頼になります。この依頼への返事は、ページの返事欄に書いてください。</p>}
        {idle ? (
          <form
            className="composer-box"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              send();
            }}
          >
            <label htmlFor="ask-sheet-input" className="sr-only">
              {onAskPage ? "新しい依頼で任せたい仕事" : "任せたい仕事"}
            </label>
            <textarea
              id="ask-sheet-input"
              ref={inputRef}
              rows={2}
              value={text}
              placeholder={onAskPage ? "例：別の件を頼む" : "例：在庫が減ったら発注して"}
              disabled={disabled}
              maxLength={2000}
              enterKeyHint="send"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // 日本語の変換中の Enter は送らない。Enter で送る・Shift+Enter で改行
                if (e.key !== "Enter" || e.nativeEvent.isComposing || e.shiftKey) return;
                e.preventDefault();
                send();
              }}
            />
            <button type="submit" className={`round-btn ${empty ? "ghost" : "solid"}`} aria-label="頼む" disabled={disabled || empty}>
              <ArrowUpIcon />
            </button>
          </form>
        ) : null}
        {state.phase === "failed" && (
          <p className="error" role="alert">
            {state.message}
          </p>
        )}
        {!idle && <Progress state={state} onAnswer={gen.answer} />}
      </div>
    </>
  );
}

function Progress({ state, onAnswer }: { state: GenState; onAnswer: AskGeneration["answer"] }) {
  return (
    <div aria-live="polite" className="ask-sheet-progress">
      {state.phase === "generating" && (
        <div className="gen ask-sheet-gen">
          <Egg />
          <p className="ask-sheet-gen-title">エージェント生成中…</p>
          {state.slow && <p className="muted">まだ考えています</p>}
        </div>
      )}
      {state.phase === "question" && state.question && <SheetQuestion q={state.question} onAnswer={onAnswer} />}
      {state.phase === "shown" && (
        <>
          <GenFormation state={state} heading="h2" />
          <p className="muted ask-sheet-next">依頼のページへ移ります</p>
        </>
      )}
    </div>
  );
}

function SheetQuestion({ q, onAnswer }: { q: NonNullable<GenState["question"]>; onAnswer: AskGeneration["answer"] }) {
  const [own, setOwn] = useState("");
  const free = q.allowFreeText || q.choices.length === 0;
  return (
    <div className="question">
      <p>{q.text}</p>
      <div className="choices">
        {q.choices.slice(0, 4).map((c) => (
          <button key={c.id} type="button" className="chip choice" onClick={() => onAnswer({ choiceId: c.id })}>
            {c.label}
          </button>
        ))}
      </div>
      {free && (
        <form
          className="own-answer"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (own.trim()) onAnswer({ text: own.trim() });
          }}
        >
          <label htmlFor="ask-sheet-own" className="sr-only">
            答えを書く
          </label>
          <input id="ask-sheet-own" value={own} onChange={(e) => setOwn(e.target.value)} maxLength={2000} />
          <button type="submit" className="btn btn-primary" disabled={!own.trim()}>
            送る
          </button>
        </form>
      )}
    </div>
  );
}
