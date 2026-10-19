// SG-07：運営のパックの手順書・指示・例・スクリプトの使い方に出てくるコマンドが、作業場で自動で動く形（run_tests）になっているか。
// 許可リスト（kernel の operationOfCommand）にない形を手順書が勧めると、担当は断られて仕事が進まない
import { describe, expect, it } from "vitest";
import { operationOfCommand } from "@open-team/kernel";
import { PACKS } from "./catalog.ts";

const PROGRAM = String.raw`(?:python3?|node|npm|pytest)`;
/** `python3 grade.py answers.csv key.csv` のようにバッククォートで囲んだコマンド */
const QUOTED = new RegExp(String.raw`\x60(${PROGRAM}\b[^\x60]*)\x60`, "g");
/** 「例: python3 contrast.py 333333 ffffff」「例：python3 …」（行末・全角の閉じ括弧・引用符まで） */
const EXAMPLE = new RegExp(String.raw`例[:：]\s*(${PROGRAM}\b[^\n）"」]*)`, "g");
/** スクリプトの「使い方: python3 x.py a.csv [b.csv]」。ASCII の語が続くところまで（[…]・日本語の置き場所の名前の手前で切る） */
const USAGE = new RegExp(String.raw`使い方:\s*(${PROGRAM}\b[^\n]*)`, "g");

function usageCommand(line: string): string {
  const words: string[] = [];
  for (const w of line.trim().split(/\s+/)) {
    if (!/^[A-Za-z0-9._/:=@%+,-]+$/.test(w)) break;
    words.push(w);
  }
  return words.join(" ");
}

interface Found {
  pack: string;
  where: string;
  command: string;
}

function commandsOf(): Found[] {
  const out: Found[] = [];
  const scan = (pack: string, where: string, text: string) => {
    for (const m of text.matchAll(QUOTED)) out.push({ pack, where, command: m[1]!.trim() });
    for (const m of text.matchAll(EXAMPLE)) out.push({ pack, where, command: m[1]!.trim() });
    for (const m of text.matchAll(USAGE)) out.push({ pack, where: `${where}（使い方）`, command: usageCommand(m[1]!) });
  };
  for (const p of PACKS) {
    for (const s of p.skills) scan(p.id, `skill:${s.name}`, `${s.description}\n${s.body}`);
    for (const a of p.agents) {
      scan(p.id, `agent:${a.key}`, `${a.summary}\n${a.instructions}`);
      for (const f of a.files ?? []) scan(p.id, `file:${f.path}`, f.content);
    }
    for (const e of p.examples ?? []) scan(p.id, "example", e);
  }
  return out;
}

describe("運営のパックに出てくるコマンド（SG-07）", () => {
  const found = commandsOf();

  it("見つかる（手順書・指示・例・スクリプトの使い方）", () => {
    // 採点・売上・商談・経費・照合・単語帳・配色・パレットのスクリプトと、エンジニアのパックのテストのコマンド
    expect(found.length).toBeGreaterThanOrEqual(12);
    const commands = new Set(found.map((f) => f.command));
    for (const c of ["python3 grade.py answers.csv key.csv", "python3 contrast.py 333333 ffffff 9a9a9a ffffff", "python3 palette.py 3b82f6", "node --test", "python3 -m unittest"]) {
      expect(commands, c).toContain(c);
    }
  });

  it("すべて汚染前なら run_tests（自動で動く形）。# のような、シェルが特別に読む文字を含まない", () => {
    const bad = found.filter((f) => operationOfCommand(f.command, false) !== "run_tests");
    expect(bad).toEqual([]);
    for (const p of PACKS) {
      const texts = [...p.skills.map((s) => s.body), ...p.agents.map((a) => a.instructions), ...(p.examples ?? [])];
      for (const t of texts) expect(t, p.id).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    }
  });
});
