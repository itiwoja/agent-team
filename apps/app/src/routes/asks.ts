// 依頼（asks）の API（/api/v1。API-072〜077 と一覧）。入出力の型は asks/contract.ts（フロントはそれに合わせる）。
// 評価の順（AS §3.0）：入力の検証（400）→ 権限（403）→ 存在（404）→ 処理。ワークスペースはセッションのものだけ（別のワークスペースの依頼は 404）。
// 生成・実行は裏で進み、結果は SSE の ask.* で届く（GET /workspaces/{id}/stream）。外部（Gemini・gateway）はルートの中のトランザクションで呼ばない

import { getAsk, getLatestLiveRun, listMembers } from "@open-team/db/asks";
import { AppError } from "@open-team/platform";
import type { AppDeps } from "../deps.ts";
import {
  AnswerAgentQuestionBodySchema,
  AnswerAskBodySchema,
  CreateAskBodySchema,
  ListAsksQuerySchema,
  ReplyAskBodySchema,
  ResumeAskBodySchema,
  type AskAcceptedResponse,
  type ResumeAskResponse,
} from "../asks/contract.ts";
import { acceptAsk, answerAskQuestion, maskUserText } from "../asks/create.ts";
import { answerQuestion } from "../asks/agent-questions.ts";
import { askSummary } from "../asks/format.ts";
import { resumeAsk, startAskRun } from "../asks/run.ts";
import { buildAskDetail, listAskSummaries, listMessages } from "../asks/view.ts";
import { idParam, readJsonBody, readQuery, requireRole, sessionOf } from "../http.ts";
import { runIdempotent } from "../idempotency.ts";
import type { ApiRouter } from "./router.ts";

/** 依頼を頼める役割：owner・maintainer（Kill Switch の発動・リハーサルと同じ。viewer は見るだけ） */
const ASKERS = ["owner", "maintainer"] as const;

/** 試験で差し替えるための入れ物（生成の打ち切り・同時実行の待ち・edge の差し替え）。本番は deps のまま */
export type AskRouteDeps = Parameters<typeof acceptAsk>[1];

export function askRoutes(r: ApiRouter, deps: AppDeps, over: Partial<AskRouteDeps> = {}): void {
  const d: AskRouteDeps = { ...deps, ...over };

  // API-072：依頼を作る（201。生成は裏で進む。Idempotency-Key を受ける）
  r.post("/asks", async (c) => {
    const s = sessionOf(c);
    const body = await readJsonBody(c, CreateAskBodySchema);
    requireRole(s, ASKERS);
    return runIdempotent<AskAcceptedResponse>(deps, c, s, { text: body.text, mention: body.mention ?? null }, (tx, now) => acceptAsk(tx, d, s, body, now), 201);
  });

  // API-073：生成中の質問に答える
  r.post("/asks/:askId/answer", async (c) => {
    const s = sessionOf(c);
    const askId = idParam(c, "askId");
    const body = await readJsonBody(c, AnswerAskBodySchema);
    requireRole(s, ASKERS);
    return runIdempotent<AskAcceptedResponse>(deps, c, s, { askId, choiceId: body.choiceId ?? null, text: body.text ?? null }, (tx, now) => answerAskQuestion(tx, d, s, askId, body, now));
  });

  // API-074：順番の失敗から再開（やり直す／ここまでで終える）
  r.post("/asks/:askId/resume", async (c) => {
    const s = sessionOf(c);
    const askId = idParam(c, "askId");
    const body = await readJsonBody(c, ResumeAskBodySchema);
    requireRole(s, ASKERS);
    const { ask } = await resumeAsk(d, s, askId, body.action);
    const members = await listMembers(deps.db, s, ask.id);
    const res: ResumeAskResponse = { ask: askSummary(ask, { members }) };
    return c.json(res);
  });

  // API-075：依頼のページ（SCR-021）の表示用ビュー
  r.get("/asks/:askId", async (c) => {
    const s = sessionOf(c);
    const view = await buildAskDetail(deps.db, s, idParam(c, "askId"));
    if (view === null) throw new AppError("NOT_FOUND");
    return c.json(view);
  });

  // API-076：連絡板（FR-064。Should）
  r.get("/asks/:askId/messages", async (c) => {
    const s = sessionOf(c);
    const res = await listMessages(deps.db, s, idParam(c, "askId"));
    if (res === null) throw new AppError("NOT_FOUND");
    return c.json(res);
  });

  // API-077：回答への返事（窓口の担当へのお願いとして、もう一度動かす。並列は窓口がないので 400）
  r.post("/asks/:askId/reply", async (c) => {
    const s = sessionOf(c);
    const askId = idParam(c, "askId");
    const body = await readJsonBody(c, ReplyAskBodySchema);
    requireRole(s, ASKERS);
    const ask = await getAsk(deps.db, s, askId);
    if (ask === null) throw new AppError("NOT_FOUND");
    if (ask.shape === "parallel") {
      throw new AppError("VALIDATION_ERROR", "並列の依頼には返事できません。入口でもう一度頼んでください", { details: [{ field: "askId", reason: "窓口がありません" }] });
    }
    if (ask.status !== "running" && ask.status !== "done") throw new AppError("ASK_NOT_WAITING");
    const previous = await getLatestLiveRun(deps.db, s, askId);
    const started = await startAskRun(d, s, askId, {
      requesterId: s.userId,
      trigger: "manual",
      reply: maskUserText(body.text),
      ...(previous?.answer_task_id == null ? {} : { replyOf: previous.answer_task_id }),
    });
    if (started === null) throw new AppError("TASK_NOT_RUNNABLE", "動いている間は返事できません。終わってからもう一度送ってください");
    void started.done;
    const fresh = (await getAsk(deps.db, s, askId)) ?? ask;
    return c.json({ ask: askSummary(fresh, { members: await listMembers(deps.db, s, askId) }) } satisfies AskAcceptedResponse, 202);
  });

  // 担当から利用者への質問（ask_user）に答える。待っている担当がそのまま受け取って続ける（もう待っていなければ 409）
  r.post("/asks/:askId/questions/:questionId/answer", async (c) => {
    const s = sessionOf(c);
    const askId = idParam(c, "askId");
    const questionId = idParam(c, "questionId");
    const body = await readJsonBody(c, AnswerAgentQuestionBodySchema);
    requireRole(s, ASKERS);
    await answerQuestion(deps, s, askId, questionId, body);
    return c.json({ ok: true });
  });

  // 入口（SCR-020）の一覧
  r.get("/asks", async (c) => {
    const s = sessionOf(c);
    const q = readQuery(c, ListAsksQuerySchema);
    return c.json(await listAskSummaries(deps.db, s, { limit: q.limit, ...(q.status === undefined ? {} : { status: q.status }) }));
  });
}
