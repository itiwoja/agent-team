// 店長パック：売上の分析・SNS の告知・口コミの見張り・仕入れ先さがし
import type { PackDefinition } from "../types.ts";

// スクリプトは String.raw で書く（Python の \n をそのまま残す）
const SALES_PY = String.raw`#!/usr/bin/env python3
"""お店の売上の分析。sales.csv（見出し：date,item,qty,amount。date は 2026-10-01 の形）を読み、
曜日ごとの売上（1日あたり）と、商品ごとの売上・ABC 分析（上位で売上の7割＝A、9割まで＝B、残り＝C）を出す。
使い方: python3 sales.py sales.csv"""
import csv, sys
from collections import defaultdict
from datetime import date

WEEKDAYS = "月火水木金土日"

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
    by_day = defaultdict(float)
    by_item = defaultdict(lambda: [0.0, 0.0])
    skipped = 0
    for r in rows:
        try:
            d = date.fromisoformat((r.get("date") or "").strip()[:10])
        except ValueError:
            skipped += 1
            continue
        amount = num(r.get("amount"))
        by_day[d] += amount
        it = by_item[(r.get("item") or "不明").strip()]
        it[0] += num(r.get("qty"))
        it[1] += amount
    if not by_day:
        print("読める行がありません（見出しは date,item,qty,amount）")
        sys.exit(1)
    total = sum(by_day.values())
    wd_sum, wd_days = defaultdict(float), defaultdict(int)
    for d, v in by_day.items():
        wd_sum[d.weekday()] += v
        wd_days[d.weekday()] += 1
    print(f"期間：{min(by_day)}〜{max(by_day)}（{len(by_day)}日）・売上 {total:,.0f}円・1日平均 {total / len(by_day):,.0f}円")
    print("\n| 曜日 | 日数 | 1日あたり |")
    print("|---|---:|---:|")
    for wd in range(7):
        if wd_days[wd]:
            print(f"| {WEEKDAYS[wd]} | {wd_days[wd]} | {wd_sum[wd] / wd_days[wd]:,.0f} |")
    print("\n| 商品 | 数量 | 売上 | 割合 | ランク |")
    print("|---|---:|---:|---:|---|")
    acc = 0.0
    for name, (qty, amount) in sorted(by_item.items(), key=lambda kv: -kv[1][1]):
        rank = "A" if acc < total * 0.7 else "B" if acc < total * 0.9 else "C"
        acc += amount
        share = amount / total if total else 0
        print(f"| {name} | {qty:g} | {amount:,.0f} | {share:.0%} | {rank} |")
    if skipped:
        print(f"\n日付が読めず飛ばした行：{skipped}件")

if __name__ == "__main__":
    main()
`;

export const SHOP: PackDefinition = {
  id: "shop",
  version: 1,
  name: "店長パック",
  tagline: "売上の分析から告知の文面、口コミのチェックまで、お店の裏方をまとめて任せる",
  description:
    "売上の明細を曜日・商品ごとに分析する担当、SNS の告知文を書く担当、お店の口コミを見張る担当、仕入れ先を探す担当の4人がそろいます。売上は作業場のスクリプトで集計するので、どの曜日・どの商品が稼いでいるかが数字で分かります。",
  audience: "飲食店・小売店のオーナー",
  category: "売る・お店",
  agents: [
    {
      key: "analyst",
      name: "売上分析マン",
      role: "dev",
      template: "dev-coder",
      summary: "売上の明細から、曜日ごと・商品ごとの稼ぎ頭を見つける",
      instructions:
        "作業場の sales.py で売上を分析してください。明細が文で渡されたら、まず sales.csv（date,item,qty,amount）にして作業場に書きます。「売上の見方」のスキルに沿って、数字と次に打つ手を報告します。",
      skills: ["売上の見方"],
      files: [
        { path: "sales.py", content: SALES_PY, executable: true },
        {
          path: "samples/sales.csv",
          content:
            "date,item,qty,amount\n2026-10-05,ブレンド,30,13500\n2026-10-05,ケーキ,10,5000\n2026-10-06,ブレンド,20,9000\n2026-10-11,ブレンド,50,22500\n2026-10-11,ケーキ,25,12500\n2026-10-11,クッキー,5,1000\n",
        },
      ],
    },
    {
      key: "sns",
      name: "SNS告知ライター",
      role: "brief",
      template: "briefer",
      summary: "新メニュー・イベント・休業のお知らせを SNS 向けに書く",
      instructions: "頼まれたお知らせを、「SNS 告知の書き方」のスキルに沿って Instagram・X・LINE 向けにそれぞれ書いてください。日時・値段など、渡されていない事実は作らず [要確認] と書きます。",
      skills: ["SNS 告知の書き方"],
    },
    {
      key: "reviews",
      name: "口コミ見張り番",
      role: "watch",
      template: "watcher",
      summary: "お店の口コミ・評判を見張り、新しい声と対応の要るものを知らせる",
      instructions: "頼まれたお店の名前で、口コミサイトやニュース・SNS の公開の投稿を Web で調べ、前回から新しく出た声だけを、ほめられた点・不満の点に分けて短く知らせてください。返信が要りそうなものには返信の案を添えます。",
      skills: [],
    },
    {
      key: "supplier",
      name: "仕入れ先リサーチ",
      role: "research",
      template: "researcher",
      summary: "食材・備品の仕入れ先を探し、条件を比べる",
      instructions: "頼まれた品の仕入れ先を Web で探し、価格・最小ロット・送料・配送日数・支払い条件を表で比べてください。出典の URL を必ず添え、分からない条件は「要問い合わせ」と書きます。",
      skills: [],
    },
  ],
  skills: [
    {
      name: "売上の見方",
      description: "曜日の波・ABC 分析・客単価から、次に打つ手を1つ決める",
      body: `# 売上の見方
1. run_command で \`python3 sales.py sales.csv\` を動かす
2. **曜日の波**：いちばん強い曜日と弱い曜日。弱い曜日はてこ入れの候補
3. **ABC 分析**：A（売上の7割）の商品は切らさない。C の商品は入れ替えの候補
4. 報告：数字の要点を3行まで、次に打つ手を1つ（例：「火曜に A の商品のセットを出す」）

- データの期間が短い（2週間未満）ときは、そのことを書き添える`,
    },
    {
      name: "SNS 告知の書き方",
      description: "1行目で用件、日時と場所、最後に行動のお願い",
      body: `# SNS 告知の書き方
- **1行目**で何のお知らせか分かるように（絵文字は1つまで）
- 日時・場所・値段・予約の要否を箇条書きで
- 最後に「ご予約は〜」「お待ちしています」など行動のお願い
- Instagram：ハッシュタグを5つまで。X：140字以内。LINE：あいさつを1文足す
- 渡されていない事実（日時・値段）は作らない`,
    },
  ],
  examples: ["先月の売上の明細から、曜日ごと・商品ごとの傾向を出して", "来週から始める秋限定メニューの告知を SNS 向けに書いて", "うちの店の口コミを毎週見張って"],
};
