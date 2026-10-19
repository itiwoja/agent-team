// 教員パック：授業プリント・採点・保護者への連絡
import type { PackDefinition } from "../types.ts";

const GRADE_PY = `#!/usr/bin/env python3
"""小テストの採点。answers.csv（1行目は見出し：name,q1,q2,...）と key.csv（q1,q2,... の正答を1行）を読み、
点数の一覧（scores.csv）と、設問ごとの正答率（item_analysis.csv）を書き出す。
使い方: python3 grade.py answers.csv key.csv [配点(既定1)]"""
import csv, sys

def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    answers_path, key_path = sys.argv[1], sys.argv[2]
    point = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0
    with open(key_path, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))
    header, key = (rows[0], rows[1]) if len(rows) > 1 else ([f"q{i+1}" for i in range(len(rows[0]))], rows[0])
    key = [k.strip() for k in key]
    with open(answers_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        students = list(reader)
    qs = [q for q in reader.fieldnames if q != "name"][: len(key)]
    correct_count = [0] * len(qs)
    out = []
    for s in students:
        score = 0.0
        for i, q in enumerate(qs):
            if (s.get(q) or "").strip() == key[i]:
                score += point
                correct_count[i] += 1
        out.append((s.get("name", ""), score))
    with open("scores.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["name", "score", "max"])
        for name, score in out:
            w.writerow([name, f"{score:g}", f"{point * len(qs):g}"])
    with open("item_analysis.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["question", "correct_rate"])
        for i, q in enumerate(qs):
            rate = correct_count[i] / len(students) if students else 0
            w.writerow([q, f"{rate:.2f}"])
    avg = sum(s for _, s in out) / len(out) if out else 0
    print(f"{len(out)}人を採点しました。平均 {avg:.2f} / {point * len(qs):g}")
    low = [q for i, q in enumerate(qs) if students and correct_count[i] / len(students) < 0.5]
    if low:
        print("正答率が5割を切った設問: " + ", ".join(low))

if __name__ == "__main__":
    main()
`;

export const TEACHER: PackDefinition = {
  id: "teacher",
  version: 1,
  name: "教員パック",
  tagline: "授業の準備・採点・保護者への連絡を、先生の代わりに片付ける",
  description:
    "授業プリントの下書き、小テストの採点と誤答の傾向の分析、学級だよりの文面までを3人の担当が分担します。採点は作業場でスクリプトを動かして数えるので、計算まちがいがありません。",
  audience: "先生・講師",
  category: "学び・教育",
  agents: [
    {
      key: "handout",
      name: "プリント錬金術師",
      role: "research",
      template: "researcher",
      summary: "単元のねらいから授業プリントの下書きを作る",
      instructions:
        "頼まれた単元と学年に合わせて、授業の配布プリントの下書きを Markdown で作ってください。必要なら Web で用語や事例を確かめ、出典を添えます。「授業プリントの型」のスキルに沿って書きます。",
      skills: ["授業プリントの型", "小テストの作り方"],
    },
    {
      key: "grader",
      name: "採点ロボ先生",
      role: "dev",
      template: "dev-coder",
      summary: "解答の CSV を採点し、設問ごとの正答率を出す",
      instructions:
        "作業場の grade.py を使って小テストを採点してください。解答と正答が文で渡されたら、まず CSV のファイルにして作業場に書きます。結果の scores.csv と item_analysis.csv を作り、正答率の低い設問と、つまずきの考えられる理由を報告します。",
      skills: ["採点の手順"],
      files: [
        { path: "grade.py", content: GRADE_PY, executable: true },
        { path: "samples/answers.csv", content: "name,q1,q2,q3,q4\n佐藤,ア,3,東京,B\n鈴木,イ,3,大阪,B\n高橋,ア,4,東京,C\n" },
        { path: "samples/key.csv", content: "q1,q2,q3,q4\nア,3,東京,B\n" },
      ],
    },
    {
      key: "letter",
      name: "学級だより記者",
      role: "brief",
      template: "briefer",
      summary: "行事や連絡を、保護者向けのやさしい文面にまとめる",
      instructions: "頼まれた行事・連絡事項を、保護者に向けた学級だよりや連絡の文面にまとめてください。「保護者連絡の書き方」のスキルに沿って、短く・やさしく書きます。",
      skills: ["保護者連絡の書き方"],
    },
  ],
  skills: [
    {
      name: "授業プリントの型",
      description: "ねらい・導入・本題・確認問題・ふりかえりの順で組み立てる",
      body: `# 授業プリントの型
1. **今日のねらい**（1文。「〜できるようになる」）
2. **導入**：身近な例や問いを1つ（3行まで）
3. **本題**：要点を3つまで、見出しと短い説明。図や表が要るところは [図：〜] と書いておく
4. **確認問題**：3〜5問（易→難）。答えはプリントの最後に分けて書く
5. **ふりかえり**：「今日わかったこと」「まだ分からないこと」の記入欄

- 1枚（A4）に収まる分量にする
- 学年に合わない漢字・用語にはふりがなか言い換えを付ける
- 調べた事実には出典を付ける`,
    },
    {
      name: "小テストの作り方",
      description: "ねらいに合わせて難易度をそろえ、正答の CSV も作る",
      body: `# 小テストの作り方
- 1問1つの力を問う。ひっかけは作らない
- 選択肢は4つ。正答の位置は偏らせない
- 易しい問題から並べ、最後の1問だけ発展にする
- 正答は key.csv（1行目 q1,q2,…、2行目に正答）の形でも書く。採点ロボ先生がそのまま使える`,
    },
    {
      name: "採点の手順",
      description: "grade.py で採点し、正答率の低い設問を報告する",
      body: `# 採点の手順
1. list_files で grade.py と解答のファイルを確かめる（samples/ に見本がある）
2. 解答が文で渡されたら answers.csv（name,q1,q2,…）と key.csv を write_file で作る
3. run_command で \`python3 grade.py answers.csv key.csv\` を動かす（配点が違うときは3つめの引数）
4. scores.csv と item_analysis.csv を read_file で確かめる
5. 報告：平均点、正答率が5割を切った設問、考えられるつまずき、次の授業での手当て（1〜2行）`,
    },
    {
      name: "保護者連絡の書き方",
      description: "日時・持ち物・お願いを先に、あいさつは短く",
      body: `# 保護者連絡の書き方
- 冒頭のあいさつは1文
- **いつ・どこで・何を・持ち物・締め切り** を箇条書きで先に
- お願いは「〜をお願いします」と具体的に。理由は1文
- 問い合わせ先を最後に書く
- 子どもの個人名・成績は書かない`,
    },
  ],
  examples: ["中学2年の「一次関数」の授業プリントを作って", "この小テストの解答を採点して、正答率の低い問題を教えて", "来週の遠足のお知らせを保護者向けに書いて"],
};
