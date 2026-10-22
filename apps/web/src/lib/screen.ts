// 画面（Route）ごとの、タブの題とヘッダーの「戻る」の行き先（main.tsx から呼ぶ。純粋な関数）
import type { Route } from "./router";

/** タブの題（画面ごと）。中身が決める題（依頼の文）と件数は lib/title.ts の composeTitle で重ねる */
export function titleOf(route: Route): string {
  switch (route.name) {
    case "home":
      return "入口";
    case "check":
      return "チェック";
    case "done":
      return "済んだもの";
    case "audit":
      return "記録";
    case "ask":
      return "依頼";
    case "agents":
      return "担当";
    case "asks":
      return "依頼の一覧";
    case "packs":
      return "パック";
    case "pack":
      return "パックの作業場";
    case "notFound":
      return "ページが見つかりません";
  }
}

/** ヘッダーの「戻る」の行き先：ひとつ上の階層（依頼→依頼の一覧、パックの作業場→棚、済んだもの→チェック）。それ以外は入口。入口自体では出さない */
export function backOf(route: Route): { to: string; label: string } | null {
  switch (route.name) {
    case "home":
      return null;
    case "pack":
      return { to: "/packs", label: "パック" };
    case "done":
      return { to: "/check", label: "チェック" };
    case "ask":
      return { to: "/asks", label: "依頼" };
    default:
      return { to: "/", label: "入口" };
  }
}
