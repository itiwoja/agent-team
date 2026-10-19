// 「用語の説明」：リハーサルの区画の末尾。文は lib/glossary.ts（ガードの語の title と同じ）
import { useId } from "react";
import { GLOSSARY, glossaryText, splitAtTerm } from "../lib/glossary";

export function Glossary() {
  return (
    <details className="glossary">
      <summary>用語の説明</summary>
      <dl className="kv">
        {GLOSSARY.map((g) => (
          <div key={g.term}>
            <dt>{g.term}</dt>
            <dd>{g.text}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/** 文の中の用語に説明を付ける（title と aria-describedby。最初に出た1か所だけ） */
export function WithTerm({ text, term }: { text: string; term: string }) {
  const id = useId();
  const desc = glossaryText(term);
  const parts = splitAtTerm(text, term);
  if (!parts || !desc) return <>{text}</>;
  return (
    <>
      {parts.before}
      <abbr className="term" title={desc} aria-describedby={id} tabIndex={0}>
        {parts.term}
      </abbr>
      <span id={id} className="sr-only">
        {desc}
      </span>
      {parts.after}
    </>
  );
}
