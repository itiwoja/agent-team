// 経理パック：経費の仕分け・入金の照合・税制の見張り
import type { PackDefinition } from "../types.ts";

// スクリプトは String.raw で書く（Python の \n をそのまま残す）
const EXPENSES_PY = String.raw`#!/usr/bin/env python3
"""経費の明細を勘定科目に仕分けて、月ごと・科目ごとに集計する。
expenses.csv（見出し：date,description,amount）を読み、rules.csv（keyword,account）の言葉が摘要に含まれれば、その勘定科目にする。
当てはまらないものは「要確認」。結果は classified.csv と、科目×月の表（標準出力）。
使い方: python3 expenses.py expenses.csv [rules.csv]
※ 勘定科目は目安です。最終の判断は税理士・経理の担当者が行ってください"""
import csv, sys
from collections import defaultdict

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    rules_path = sys.argv[2] if len(sys.argv) > 2 else "rules.csv"
    with open(rules_path, newline="", encoding="utf-8-sig") as f:
        rules = [(r["keyword"].strip(), r["account"].strip()) for r in csv.DictReader(f) if r.get("keyword")]
    with open(sys.argv[1], newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    table = defaultdict(lambda: defaultdict(float))
    months = set()
    unknown = 0
    with open("classified.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["date", "description", "amount", "account"])
        for r in rows:
            desc = r.get("description", "")
            account = next((a for k, a in rules if k and k in desc), "要確認")
            if account == "要確認":
                unknown += 1
            amount = float(str(r.get("amount", "0")).replace(",", "") or 0)
            month = (r.get("date") or "")[:7]
            months.add(month)
            table[account][month] += amount
            w.writerow([r.get("date", ""), desc, f"{amount:g}", account])
    ms = sorted(months)
    print("| 勘定科目 | " + " | ".join(ms) + " | 合計 |")
    print("|---|" + "---:|" * (len(ms) + 1))
    for account in sorted(table, key=lambda a: (a == "要確認", a)):
        vals = [table[account].get(m, 0) for m in ms]
        print(f"| {account} | " + " | ".join(f"{v:,.0f}" for v in vals) + f" | {sum(vals):,.0f} |")
    print(f"\n{len(rows)}件を仕分けました（要確認 {unknown}件）。明細は classified.csv")

if __name__ == "__main__":
    main()
`;
const RECONCILE_PY = String.raw`#!/usr/bin/env python3
"""請求と入金の突き合わせ。invoices.csv（invoice_no,client,amount,due）と payments.csv（date,payer,amount[,memo]）を読み、
金額と取引先の名前（部分一致）で入金を請求に当てる。当たらない請求（未入金）・当たらない入金（不明な入金）・金額の違いを出す。
使い方: python3 reconcile.py invoices.csv payments.csv"""
import csv, sys

def load(p):
    with open(p, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))

def amt(v):
    return float(str(v).replace(",", "").replace("円", "") or 0)

def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    invoices, payments = load(sys.argv[1]), load(sys.argv[2])
    used = set()
    unpaid, partial = [], []
    for inv in invoices:
        client = inv["client"].strip()
        hit = None
        for i, p in enumerate(payments):
            if i in used:
                continue
            payer = p["payer"].strip()
            if client in payer or payer in client:
                hit = i
                if amt(p["amount"]) == amt(inv["amount"]):
                    break
        if hit is None:
            unpaid.append(inv)
            continue
        used.add(hit)
        diff = amt(payments[hit]["amount"]) - amt(inv["amount"])
        if diff != 0:
            partial.append((inv, payments[hit], diff))
    unknown = [p for i, p in enumerate(payments) if i not in used]
    print(f"請求 {len(invoices)}件・入金 {len(payments)}件")
    print(f"\n## 未入金（{len(unpaid)}件）")
    for inv in unpaid:
        print(f"- {inv['invoice_no']} {inv['client']} {amt(inv['amount']):,.0f}円（期日 {inv.get('due', '')}）")
    print(f"\n## 金額の違い（{len(partial)}件）")
    for inv, p, diff in partial:
        print(f"- {inv['invoice_no']} {inv['client']}：請求 {amt(inv['amount']):,.0f}円・入金 {amt(p['amount']):,.0f}円（差 {diff:+,.0f}円。振込手数料の差し引きかもしれません）")
    print(f"\n## 当たらない入金（{len(unknown)}件）")
    for p in unknown:
        print(f"- {p['date']} {p['payer']} {amt(p['amount']):,.0f}円")

if __name__ == "__main__":
    main()
`;

const RULES_CSV = "keyword,account\nタクシー,旅費交通費\n電車,旅費交通費\n新幹線,旅費交通費\nコーヒー,会議費\n打ち合わせ,会議費\n会食,接待交際費\n切手,通信費\n携帯,通信費\nコピー用紙,消耗品費\n文具,消耗品費\n書籍,新聞図書費\n";

export const ACCOUNTING: PackDefinition = {
  id: "accounting",
  version: 1,
  name: "経理パック",
  tagline: "経費の仕分けと入金の照合を、スクリプトで正確に片付ける",
  description:
    "経費の明細を勘定科目に仕分けて月ごとに集計する担当、請求と入金を突き合わせて未入金を見つける担当、税制の変更を見張る担当の3人がそろいます。数えるのは作業場のスクリプトなので、計算の取りこぼしがありません。最終の判断は税理士・経理の担当者が行ってください。",
  audience: "経理・個人事業主",
  category: "お金・事務",
  agents: [
    {
      key: "expenses",
      name: "経費仕分けロボ",
      role: "dev",
      template: "dev-coder",
      summary: "経費の明細を勘定科目に仕分け、科目×月で集計する",
      instructions:
        "作業場の expenses.py と rules.csv で経費の明細を仕分けてください。明細が文で渡されたら、まず expenses.csv（date,description,amount）にして作業場に書きます。「仕訳の目安」のスキルに沿って報告し、要確認の行には科目の候補を添えます。",
      skills: ["仕訳の目安"],
      files: [
        { path: "expenses.py", content: EXPENSES_PY, executable: true },
        { path: "rules.csv", content: RULES_CSV },
        {
          path: "samples/expenses.csv",
          content: "date,description,amount\n2026-10-01,タクシー 渋谷,2300\n2026-10-03,打ち合わせ コーヒー,1200\n2026-10-15,コピー用紙,880\n2026-11-02,新幹線 東京-大阪,14720\n2026-11-05,クラウド利用料,3300\n",
        },
      ],
    },
    {
      key: "reconcile",
      name: "入金照合チェッカー",
      role: "dev",
      template: "dev-coder",
      summary: "請求と入金を突き合わせ、未入金・金額の違いを見つける",
      instructions:
        "作業場の reconcile.py で請求（invoices.csv）と入金（payments.csv）を突き合わせてください。データが文で渡されたら、まず CSV にして作業場に書きます。未入金は期日の近い順に、金額の違いは考えられる理由（振込手数料など）を添えて報告します。",
      skills: [],
      files: [
        { path: "reconcile.py", content: RECONCILE_PY, executable: true },
        {
          path: "samples/invoices.csv",
          content: "invoice_no,client,amount,due\nINV-001,山田商店,110000,2026-10-31\nINV-002,海辺カフェ,55000,2026-10-31\nINV-003,北町書房,33000,2026-11-15\n",
        },
        { path: "samples/payments.csv", content: "date,payer,amount\n2026-10-28,ヤマダショウテン 山田商店,110000\n2026-10-30,海辺カフェ,54340\n2026-10-30,ミナミ工業,22000\n" },
      ],
    },
    {
      key: "tax",
      name: "税制ウォッチャー",
      role: "watch",
      template: "watcher",
      summary: "税制・インボイス・電子帳簿の変更を見張り、影響だけ知らせる",
      instructions:
        "国税庁などの公的な発表を Web で調べ、前回から新しく出た税制・インボイス制度・電子帳簿保存の変更だけを、いつから・誰に・何が変わるかの形で短く知らせてください。出典の URL を必ず添え、最終の判断は税理士に確かめるよう書き添えます。",
      skills: [],
    },
  ],
  skills: [
    {
      name: "仕訳の目安",
      description: "よく使う勘定科目の目安と、要確認の行の扱い",
      body: `# 仕訳の目安
- **旅費交通費**：電車・バス・タクシー・新幹線・出張の宿泊
- **会議費**：打ち合わせの飲み物・軽食（1人あたり少額のもの）
- **接待交際費**：取引先との会食・贈答
- **通信費**：電話・インターネット・切手
- **消耗品費**：文具・コピー用紙・少額の備品
- **新聞図書費**：書籍・新聞・有料の記事
- **支払手数料**：振込手数料・各種の手数料

1. run_command で \`python3 expenses.py expenses.csv rules.csv\` を動かす
2. 「要確認」の行は、摘要から科目の候補を1つ挙げ、rules.csv に足す言葉を提案する（書き足すのは頼まれたときだけ）
3. 報告：科目×月の表、要確認の行と候補、「最終の判断は税理士・経理の担当者へ」の一言`,
    },
  ],
  examples: ["この経費の明細を勘定科目に仕分けて、月ごとに集計して", "請求の一覧と入金の明細を突き合わせて、未入金を出して", "インボイス制度の変更を毎月見張って"],
};
