// 「新しいエージェントを作る」の入力欄（ダイアログ）。したいことを書いて送る。失敗は欄の下に出し、書いた文は残す
import { useEffect, useId, useRef, type FormEvent } from "react";
import { useRestoreFocus } from "../lib/useRestoreFocus";
import { trapTab } from "../ui/trapTab";

/** サーバーの上限（POST /agents の text は前後の空白を除いて 1〜2000 文字） */
export const AGENT_TEXT_MAX = 2000;

export function NewAgentSheet({ text, onText, error, onSubmit, onClose }: { text: string; onText: (t: string) => void; error: string | null; onSubmit: (text: string) => void; onClose: () => void }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useRestoreFocus();

  useEffect(() => areaRef.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
        return;
      }
      trapTab(e, dialogRef.current);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const trimmed = text.trim();
  const valid = trimmed.length > 0 && trimmed.length <= AGENT_TEXT_MAX;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) onSubmit(trimmed);
  };

  return (
    <div className="agent-modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="agent-modal-card" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef}>
        <form className="inline-form" onSubmit={submit}>
          <h2 className="agent-modal-title" id={titleId}>
            新しいエージェントを作る
          </h2>
          <label className="muted small" htmlFor={`${titleId}-text`}>
            どんなことをしてほしいですか。名前や役割は、書いた内容から決まります
          </label>
          <textarea
            id={`${titleId}-text`}
            ref={areaRef}
            value={text}
            onChange={(e) => onText(e.target.value)}
            placeholder="例：毎朝、気になるニュースを3本まとめてほしい"
            maxLength={AGENT_TEXT_MAX + 200}
            aria-describedby={error ? `${titleId}-error` : undefined}
          />
          {text.trim().length > AGENT_TEXT_MAX && <p className="error small">{AGENT_TEXT_MAX}文字までです</p>}
          {error && (
            <p className="error small" id={`${titleId}-error`} role="alert">
              {error}
            </p>
          )}
          <div className="agent-modal-actions">
            <button type="button" className="btn" onClick={onClose}>
              やめる
            </button>
            <button type="submit" className="btn btn-primary" disabled={!valid}>
              作る
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
