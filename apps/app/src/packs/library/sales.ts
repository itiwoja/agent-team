// 営業パック：商談の準備・提案書の下書き・案件の数字・競合の見張り
import type { PackDefinition } from "../types.ts";

// スクリプトは String.raw で書く（Python の \n をそのまま残す）
const PIPELINE_PY = String.raw`#!/usr/bin/env python3
"""案件（商談）の CSV を集計する。deals.csv（見出し：name,stage,amount,probability[,close_month]）を読み、
段階ごとの件数・金額と、確度をかけた見込み（加重）を出す。close_month（例 2026-11）があれば月ごとの見込みも出す。
使い方: python3 pipeline.py deals.csv"""
import csv, sys
from collections import defaultdict

def num(v):
    try:
        return float(str(v).replace(",", "").replace("円", "").strip() or 0)
    except ValueError:
        return 0.0

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    with open(sys.argv[1], newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    by_stage = defaultdict(lambda: [0, 0.0, 0.0])
    by_month = defaultdict(float)
    for r in rows:
        amount = num(r.get("amount"))
        p = num(r.get("probability"))
        p = p / 100 if p > 1 else p
        s = by_stage[(r.get("stage") or "不明").strip()]
        s[0] += 1
        s[1] += amount
        s[2] += amount * p
        if r.get("close_month"):
            by_month[r["close_month"].strip()] += amount * p
    print("| 段階 | 件数 | 金額 | 見込み（確度をかけた額） |")
    print("|---|---:|---:|---:|")
    for stage, (n, total, weighted) in sorted(by_stage.items(), key=lambda kv: -kv[1][2]):
        print(f"| {stage} | {n} | {total:,.0f} | {weighted:,.0f} |")
    print(f"\n合計：{len(rows)}件・{sum(v[1] for v in by_stage.values()):,.0f}円・見込み {sum(v[2] for v in by_stage.values()):,.0f}円")
    if by_month:
        print("\n| 月 | 見込み |")
        print("|---|---:|")
        for m in sorted(by_month):
            print(f"| {m} | {by_month[m]:,.0f} |")

if __name__ == "__main__":
    main()
`;

export const SALES: PackDefinition = {
  id: "sales",
  version: 1,
  name: "営業パック",
  tagline: "商談の下調べから提案書、見込みの数字まで、営業の段取りを肩代わりする",
  description:
    "相手先の下調べ、提案書の下書き、案件の一覧からの見込みの集計、競合の動きの見張りを4人の担当が分担します。数字は作業場のスクリプトで数えるので、確度をかけた見込みも月ごとに正確に出ます。",
  audience: "営業・事業開発",
  category: "売る・お店",
  agents: [
    {
      key: "prep",
      name: "商談リサーチ探偵",
      role: "research",
      template: "researcher",
      summary: "相手先の会社を調べ、商談の準備シートを作る",
      instructions: "頼まれた会社を Web で調べ、「商談準備シート」のスキルに沿ってまとめてください。公開されている情報だけを使い、出典の URL を必ず添えます。",
      skills: ["商談準備シート"],
    },
    {
      key: "proposal",
      name: "提案書の下書き職人",
      role: "brief",
      template: "briefer",
      summary: "相手の課題に合わせて、提案書の骨子と文面を作る",
      instructions: "頼まれた相手と商材について、「提案の型」のスキルに沿って提案書の下書きを Markdown で作ってください。分からない数字は [要確認] と書き、作りません。",
      skills: ["提案の型"],
    },
    {
      key: "numbers",
      name: "数字まとめ番長",
      role: "dev",
      template: "dev-coder",
      summary: "案件の一覧から、段階ごと・月ごとの見込みを集計する",
      instructions:
        "作業場の pipeline.py で案件の一覧を集計してください。案件が文で渡されたら、まず deals.csv（name,stage,amount,probability,close_month）にして作業場に書きます。「案件の集計」のスキルに沿って報告します。",
      skills: ["案件の集計"],
      files: [
        { path: "pipeline.py", content: PIPELINE_PY, executable: true },
        {
          path: "samples/deals.csv",
          content: "name,stage,amount,probability,close_month\nA社 研修,提案,1200000,40,2026-11\nB社 更新,交渉,800000,70,2026-11\nC社 新規,初回面談,500000,10,2026-12\nD社 追加,受注,300000,100,2026-10\n",
        },
      ],
    },
    {
      key: "watch",
      name: "競合ニュース見張り番",
      role: "watch",
      template: "watcher",
      summary: "競合や取引先のニュースを見張り、商談に効く動きだけ知らせる",
      instructions: "頼まれた会社（競合・取引先）のニュースやプレスリリースを Web で調べ、前回から新しく出たもののうち、値上げ・新製品・提携・人事など商談に効くものだけを短く知らせてください。出典を添えます。",
      skills: [],
    },
  ],
  skills: [
    {
      name: "商談準備シート",
      description: "会社の概要・最近の動き・想定の課題・聞くことを1枚にまとめる",
      body: `# 商談準備シート
1. **会社の概要**：事業・規模・主な顧客（3行まで）
2. **最近の動き**：直近1年のニュース・発表を3つまで（日付と出典つき）
3. **想定の課題**：上の動きから考えられる困りごとを2〜3個（推測であることを書く）
4. **当日聞くこと**：課題を確かめる質問を3〜5個
5. **こちらから出す話題**：課題に合う事例や機能を1〜2個

- 公開の情報だけを使う。個人の私生活には触れない`,
    },
    {
      name: "提案の型",
      description: "課題→解決→効果→費用→次の一歩の順で書く",
      body: `# 提案の型
1. **ご提案の要旨**（3行）
2. **現状の課題**：相手の言葉で書く
3. **解決の方法**：何を・どう使うか
4. **期待できる効果**：数字で言えるものは数字で。根拠のない数字は書かない（[要確認]）
5. **進め方と費用**：段階と期間、費用の目安
6. **次の一歩**：相手に決めてほしいことを1つ

- 1ページ目だけ読めば分かるようにする
- 専門用語は相手の業界の言葉に言い換える`,
    },
    {
      name: "案件の集計",
      description: "pipeline.py で段階ごと・月ごとの見込みを出し、手を打つ案件を挙げる",
      body: `# 案件の集計
1. list_files で pipeline.py と案件のファイルを確かめる（samples/ に見本がある）
2. 案件が文で渡されたら deals.csv（name,stage,amount,probability,close_month）を write_file で作る。確度は 0〜100
3. run_command で \`python3 pipeline.py deals.csv\` を動かす
4. 報告：見込みの合計、月ごとの見込み、確度が中くらい（30〜70）で金額の大きい案件＝いま手を打つ案件を3つまで`,
    },
  ],
  examples: ["来週商談する株式会社〇〇の準備シートを作って", "この案件の一覧から今月と来月の見込みを出して", "競合の〇〇社のニュースを毎週見張って"],
};
