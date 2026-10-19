// 学生パック：勉強の計画・レポートの組み立て・単語帳
import type { PackDefinition } from "../types.ts";

// スクリプトは String.raw で書く（Python の \n をそのまま残す）
const FLASHCARDS_PY = String.raw`#!/usr/bin/env python3
"""単語帳を作る。words.csv（見出し：word,meaning）を読み、Anki などに取り込める cards.tsv と、
4択の小テスト quiz.md（問題と、最後に答え）を書き出す。
使い方: python3 flashcards.py words.csv [問題数(既定10)] [乱数の種(既定1)]"""
import csv, random, sys

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    with open(sys.argv[1], newline="", encoding="utf-8-sig") as f:
        words = [(r["word"].strip(), r["meaning"].strip()) for r in csv.DictReader(f) if (r.get("word") or "").strip() and (r.get("meaning") or "").strip()]
    if not words:
        print("単語がありません（見出しは word,meaning）")
        sys.exit(1)
    count = int(sys.argv[2]) if len(sys.argv) > 2 else 10
    rng = random.Random(int(sys.argv[3]) if len(sys.argv) > 3 else 1)
    with open("cards.tsv", "w", encoding="utf-8") as f:
        for w, m in words:
            f.write(w.replace("\t", " ") + "\t" + m.replace("\t", " ") + "\n")
    picked = rng.sample(words, min(count, len(words)))
    meanings = sorted({m for _, m in words})
    labels = "ABCD"
    lines, answers = ["# 単語の小テスト", ""], []
    for i, (w, m) in enumerate(picked, 1):
        others = [x for x in meanings if x != m]
        choices = rng.sample(others, min(3, len(others))) + [m]
        rng.shuffle(choices)
        lines.append(f"{i}. **{w}** の意味は？")
        for j, c in enumerate(choices):
            lines.append(f"   - {labels[j]}. {c}")
        answers.append(f"{i}. {labels[choices.index(m)]}（{m}）")
    lines += ["", "## 答え", ""] + answers
    with open("quiz.md", "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"{len(words)}語を cards.tsv に、{len(picked)}問を quiz.md に書きました")

if __name__ == "__main__":
    main()
`;

export const STUDENT: PackDefinition = {
  id: "student",
  version: 1,
  name: "学生パック",
  tagline: "試験までの計画づくり、レポートの組み立て、単語の暗記を手伝う",
  description:
    "試験日から逆算して勉強の計画を立てる担当、レポートの構成と参考文献さがしを手伝う担当、単語の一覧から単語帳と小テストを作る担当の3人がそろいます。レポートは本文を代わりに書くのではなく、考える筋道と根拠の集め方を手伝います。",
  audience: "学生・資格の勉強",
  category: "学び・教育",
  agents: [
    {
      key: "plan",
      name: "勉強計画コーチ",
      role: "brief",
      template: "briefer",
      summary: "試験日と範囲から、毎日の勉強の計画を逆算する",
      instructions: "頼まれた試験の日付・範囲・1日に使える時間から、「逆算の計画」のスキルに沿って勉強の計画を作ってください。無理のある計画なら、削る範囲の案も出します。",
      skills: ["逆算の計画"],
    },
    {
      key: "report",
      name: "レポート参謀",
      role: "research",
      template: "researcher",
      summary: "レポートの構成と、根拠になる参考文献を探す",
      instructions:
        "頼まれたテーマについて、「レポートの型」のスキルに沿って構成案と参考になる文献・資料を Web で探してください。出典の URL を必ず添えます。本文をそのまま提出できる形で書くことはせず、構成・論点・根拠の集め方を手伝います。",
      skills: ["レポートの型"],
    },
    {
      key: "cards",
      name: "単語帳メーカー",
      role: "dev",
      template: "dev-coder",
      summary: "単語の一覧から、単語帳（Anki 用）と4択の小テストを作る",
      instructions:
        "作業場の flashcards.py で単語帳と小テストを作ってください。単語が文や表で渡されたら、まず words.csv（word,meaning）にして作業場に書きます。できた cards.tsv と quiz.md の場所と、使い方を短く報告します。",
      skills: [],
      files: [
        { path: "flashcards.py", content: FLASHCARDS_PY, executable: true },
        { path: "samples/words.csv", content: "word,meaning\napple,りんご\nborrow,借りる\ncarry,運ぶ\ndecide,決める\nexplain,説明する\n" },
      ],
    },
  ],
  skills: [
    {
      name: "逆算の計画",
      description: "試験日から逆に区切り、復習と予備の日を先に取る",
      body: `# 逆算の計画
1. 試験日・範囲・1日に使える時間を確かめる（足りなければ ask_user で聞く）
2. 最後の2〜3日は **総復習** に取る。週に1日は **予備の日**（遅れを取り戻す日）
3. 残りの日に範囲を割り振る。苦手な単元は早めに・多めに
4. 1日の中身は「新しく進める」と「前の日の復習（15分）」の2つ
5. 表（日付・やること・目安の時間）で出す

- 1日に使える時間を超える計画は出さない。超えるなら削る案を添える`,
    },
    {
      name: "レポートの型",
      description: "問い→主張→根拠→反論→結論の順に組み立てる",
      body: `# レポートの型
1. **問い**：何を明らかにするか（1文）
2. **主張**：問いへの答え（1文）
3. **根拠**：主張を支える資料を2〜3つ（著者・題名・年・URL）
4. **反論と応答**：考えられる反対の意見と、それへの答え
5. **結論**：主張をもう一度、分かったことと残る課題

- 出すのは構成案と論点・資料まで。本文の丸写しにつながる長い文章は書かない
- 資料は公的機関・学術論文・書籍を優先する`,
    },
  ],
  examples: ["12月10日の期末試験まで、数学と英語の勉強計画を立てて", "「SNS と若者の政治参加」のレポートの構成と参考文献を探して", "この英単語の一覧から単語帳と小テストを作って"],
};
