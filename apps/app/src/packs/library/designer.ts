// デザイナーパック：競合調査・配色の検証・トレンドの見張り
import type { PackDefinition } from "../types.ts";

const CONTRAST_PY = `#!/usr/bin/env python3
"""色のコントラスト比（WCAG 2.x）を測る。
使い方: python3 contrast.py 文字色 背景色 [文字色 背景色 ...]   例: python3 contrast.py 333333 ffffff 9a9a9a ffffff
色は # を付けずに書く（# はシェルではコメントの始まりになる）"""
import sys

def lum(hex_color):
    h = hex_color.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    rgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]

def ratio(a, b):
    la, lb = sorted([lum(a), lum(b)], reverse=True)
    return (la + 0.05) / (lb + 0.05)

def main():
    args = sys.argv[1:]
    if len(args) < 2 or len(args) % 2:
        print(__doc__)
        sys.exit(2)
    print("文字色,背景色,比,AA本文(4.5),AA大きな文字(3.0),AAA本文(7.0)")
    for fg, bg in zip(args[::2], args[1::2]):
        r = ratio(fg, bg)
        ok = lambda t: "OK" if r >= t else "NG"
        print(f"{fg},{bg},{r:.2f},{ok(4.5)},{ok(3.0)},{ok(7.0)}")

if __name__ == "__main__":
    main()
`;

const PALETTE_PY = `#!/usr/bin/env python3
"""基準の色から、明るさの段階（50〜900）のパレットを作る。
使い方: python3 palette.py 3b82f6   （色は # を付けずに書く）"""
import colorsys, sys

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    h = sys.argv[1].lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    hue, light, sat = colorsys.rgb_to_hls(r, g, b)
    steps = {50: 0.96, 100: 0.92, 200: 0.84, 300: 0.74, 400: 0.62, 500: light, 600: 0.42, 700: 0.34, 800: 0.26, 900: 0.18}
    for k, l in steps.items():
        rr, gg, bb = colorsys.hls_to_rgb(hue, l, sat)
        print(f"{k}: #{int(rr * 255):02x}{int(gg * 255):02x}{int(bb * 255):02x}")

if __name__ == "__main__":
    main()
`;

export const DESIGNER: PackDefinition = {
  id: "designer",
  version: 1,
  name: "デザイナーパック",
  tagline: "競合調査・配色の検証・トレンドの見張りを任せて、つくることに集中する",
  description:
    "競合サイトの調べもの、配色のコントラスト比の計算とパレット作り、デザインの話題の見張りを3人の担当が分担します。配色は作業場のスクリプトで数値を出すので、感覚ではなく根拠つきで判断できます。",
  audience: "デザイナー・Web 制作",
  category: "つくる",
  agents: [
    {
      key: "research",
      name: "競合リサーチ探偵",
      role: "research",
      template: "researcher",
      summary: "競合のサイトを調べ、見せ方・導線・言葉づかいを比べる",
      instructions: "頼まれたサービスや業界の競合サイトを調べ、「競合調査の観点」のスキルに沿って比べてください。出典の URL を必ず添えます。",
      skills: ["競合調査の観点"],
    },
    {
      key: "color",
      name: "配色の番人",
      role: "dev",
      template: "dev-coder",
      summary: "コントラスト比を測り、読みやすいパレットを作る",
      instructions:
        "作業場の contrast.py で文字色と背景色のコントラスト比を測り、palette.py で基準の色からパレットを作ってください。基準に届かない組み合わせには、近い色で届く案を出します。色コードは # を付けずに渡します（例：python3 contrast.py 333333 ffffff）。「アクセシビリティの確認項目」のスキルに沿って報告します。",
      skills: ["アクセシビリティの確認項目"],
      files: [
        { path: "contrast.py", content: CONTRAST_PY, executable: true },
        { path: "palette.py", content: PALETTE_PY, executable: true },
      ],
    },
    {
      key: "trend",
      name: "トレンド見張り番",
      role: "watch",
      template: "watcher",
      summary: "デザインの話題を見張り、新しい動きだけを知らせる",
      instructions: "頼まれたテーマ（例：UI デザインの新しい手法・ツールの更新）を Web で調べ、前回から新しく出たものだけを短く知らせてください。",
      skills: [],
    },
  ],
  skills: [
    {
      name: "競合調査の観点",
      description: "第一印象・導線・言葉・信頼の材料の4つで比べる",
      body: `# 競合調査の観点
1. **第一印象**：ファーストビューで何を約束しているか（見出しの言葉をそのまま引用）
2. **導線**：最初の行動（登録・問い合わせ・購入）までのクリック数
3. **言葉づかい**：誰に向けた言葉か、専門用語の多さ
4. **信頼の材料**：実績・事例・料金の見せ方

- 表にまとめる（行＝サイト、列＝観点）
- 最後に「真似したい点」と「避けたい点」を1つずつ`,
    },
    {
      name: "アクセシビリティの確認項目",
      description: "WCAG のコントラスト比の基準と、色だけに頼らない表現",
      body: `# アクセシビリティの確認項目
- 本文の文字：コントラスト比 **4.5:1 以上**（AA）。大きな文字（18pt・太字14pt 以上）は **3:1 以上**
- アイコン・入力欄の枠などの UI 部品：**3:1 以上**
- 色だけで状態を伝えない（エラーは色＋文字かアイコン）
- 報告は「組み合わせ・比・判定・直す案（色コード）」の表で`,
    },
  ],
  examples: ["カフェ予約サービスの競合サイトを3つ比べて", "グレー（9a9a9a）の文字を白背景で使って大丈夫か測って、ダメなら直して", "UI デザインの新しいトレンドを毎朝見張って"],
};
