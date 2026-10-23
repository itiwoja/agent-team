// 依頼（asks）の API（/api/v1。apps/app/src/routes/asks.ts の読む部分の WorkspaceDO 版）。入出力の型は views/asks/contract.ts。
// 評価の順（AS §3.0）：セッション（401）→ 入力の検証（400）→ 存在（404）→ 処理。ワークスペースはセッションのものだけ（別のワークスペースの依頼は 404）。
// 書き込みは受け付け（POST /asks・answer。Idempotency-Key を受ける）。resume・reply・質問への答えは実行と一緒に第4段で移す。
// 使えるのはワークスペースの持ち主だけ（D1 の memberships は owner だけ）なので、役割（requireRole）は見ない

import { AppError } from "@open-team/platform";
import { idempotencyOf } from "../idempotency.ts";
import { AnswerAskBodySchema, CreateAskBodySchema, ListAsksQuerySchema } from "../views/asks/contract.ts";
import type { ApiRouter, ApiDeps } from "./router.ts";
import { idParam, readJsonBody, readQuery, reply, sessionOf, workspaceOf } from "./router.ts";

export function askRoutes(r: ApiRouter, deps: ApiDeps): void {
  // API-072：依頼を作る（201。生成は裏で進む）
  r.post("/asks", async (c) => {
    const s = sessionOf(c);
    const body = await readJsonBody(c, CreateAskBodySchema);
    const idem = idempotencyOf(c, { text: body.text, mention: body.mention ?? null, packId: body.packId ?? null });
    return reply(c, await workspaceOf(c, s).acceptAsk({ userId: s.userId, body, idem, now: deps.now() }));
  });

  // API-073：生成中の質問に答える
  r.post("/asks/:askId/answer", async (c) => {
    const s = sessionOf(c);
    const askId = idParam(c, "askId");
    const body = await readJsonBody(c, AnswerAskBodySchema);
    const idem = idempotencyOf(c, { askId, choiceId: body.choiceId ?? null, text: body.text ?? null });
    return reply(c, await workspaceOf(c, s).answerAskQuestion({ userId: s.userId, askId, body, idem, now: deps.now() }));
  });

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
