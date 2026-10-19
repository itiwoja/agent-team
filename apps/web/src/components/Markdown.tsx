// 回答・報告の本文を描画する。lib/markdown.ts が分けた木を React の要素にする（HTML 文字列は使わない）
import { Fragment, useMemo } from "react";
import { type Block, type Inline, parseMarkdown } from "../lib/markdown";

export function Markdown({ text, className }: { text: string; className?: string }) {
  // 構文解析は本文が変わったときだけ（親の再描画ごとにやり直さない）
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className={className ? `md ${className}` : "md"}>{blocks.map((b, i) => renderBlock(b, i))}</div>;
}

function renderBlock(b: Block, key: number) {
  switch (b.kind) {
    case "paragraph":
      return (
        <p key={key} className="md-p">
          {renderInline(b.inline)}
        </p>
      );
    case "heading": {
      const H = b.level <= 3 ? "h3" : "h4";
      return (
        <H key={key} className="md-h">
          {renderInline(b.inline)}
        </H>
      );
    }
    case "list": {
      const L = b.ordered ? "ol" : "ul";
      return (
        <L key={key} className="md-list">
          {b.items.map((it, i) => (
            <li key={i} className={it.depth > 0 ? `md-li md-li-${it.depth}` : "md-li"}>
              {renderInline(it.inline)}
            </li>
          ))}
        </L>
      );
    }
    case "table":
      return (
        <div key={key} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {b.header.map((c, i) => (
                  <th key={i} scope="col">
                    {renderInline(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j}>{renderInline(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "rule":
      return <hr key={key} className="md-rule" />;
  }
}

function renderInline(inline: Inline[]) {
  return inline.map((x, i) => {
    switch (x.kind) {
      case "strong":
        return <strong key={i}>{withBreaks(x.text)}</strong>;
      case "code":
        return (
          <code key={i} className="md-code">
            {x.text}
          </code>
        );
      case "link":
        // 行き先は押す前に分かるよう title に出す。開いた先からこの画面を触らせない（noopener）・送り元を渡さない（noreferrer）
        return (
          <a key={i} className="md-link" href={x.url} target="_blank" rel="noopener noreferrer nofollow" title={x.url}>
            {x.text}
          </a>
        );
      default:
        return <Fragment key={i}>{withBreaks(x.text)}</Fragment>;
    }
  });
}

/** 表のセルなどに LLM が書く <br> を、文字のまま見せずに改行として出す */
function withBreaks(text: string) {
  const parts = text.split(/<br\s*\/?>/i);
  return parts.length === 1
    ? text
    : parts.map((t, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          {t}
        </Fragment>
      ));
}
