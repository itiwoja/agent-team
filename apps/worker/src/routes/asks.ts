// 依頼（asks）の API（/api/v1。apps/app/src/routes/asks.ts の読む部分の WorkspaceDO 版）。入出力の型は views/asks/contract.ts。
// 評価の順（AS §3.0）：セッション（401）→ 入力の検証（400）→ 存在（404）→ 処理。ワークスペースはセッションのものだけ（別のワークスペースの依頼は 404）。
// 書き込み（POST /asks・answer・resume・reply・質問への答え）は生成・実行と一緒に第4段で移す

import { AppError } from "@open-team/platform";
import { ListAsksQuerySchema } from "../views/asks/contract.ts";
import type { ApiRouter } from "./router.ts";
import { idParam, readQuery, sessionOf, workspaceOf } from "./router.ts";

export function askRoutes(r: ApiRouter): void {
  // 入口（SCR-020）の一覧
  r.get("/asks", async (c) => {
    const s = sessionOf(c);
    const q = readQuery(c, ListAsksQuerySchema);
    return c.json(await workspaceOf(c, s).listAsks({ limit: q.limit, ...(q.status === undefined ? {} : { status: q.status }) }));
  });

  // API-075：依頼のページ（SCR-021）の表示用ビュー
  r.get("/asks/:askId", async (c) => {
    const s = sessionOf(c);
    const view = await workspaceOf(c, s).askDetail(idParam(c, "askId"));
    if (view === null) throw new AppError("NOT_FOUND");
    return c.json(view);
  });

  // API-076：連絡板（FR-064。Should）
  r.get("/asks/:askId/messages", async (c) => {
    const s = sessionOf(c);
    const res = await workspaceOf(c, s).askMessages(idParam(c, "askId"));
    if (res === null) throw new AppError("NOT_FOUND");
    return c.json(res);
  });
}
