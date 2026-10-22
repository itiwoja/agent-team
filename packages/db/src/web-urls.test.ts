// タスクが見た URL の集合（SG-04・task_web_urls）：タスクを作るときに利用者の文の URL を入れ、汚染を引き継ぐ元の集合を写す。
// 読む・写すはどれもワークスペースで絞る
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Db } from "./client.ts";
import { insertAskTask, insertFollowupTask } from "./repo/asks.ts";
import { getTask } from "./repo/edge.ts";
import { addTaskWebUrls, copyTaskWebUrls, hasTaskWebUrl, TASK_WEB_URLS_MAX } from "./repo/web-urls.ts";
import { fxAgent, fxAsk, fxAskMember, fxAskRun, fxTask, fxWorkspace, useTestDb, type FxAgent, type FxWorkspace } from "./testing.ts";
import type { Uuid } from "./types.ts";

const T = useTestDb();
const NOW = new Date("2026-10-15T09:00:00.000Z");
const h = (url: string): string => createHash("sha256").update(url, "utf8").digest("hex");

interface World {
  ws: FxWorkspace;
  agent: FxAgent;
  askId: Uuid;
  askRunId: Uuid;
  memberId: Uuid;
}

async function world(db: Db, second = false): Promise<World> {
  const ws = await fxWorkspace(db, { second });
  const agent = await fxAgent(db, ws);
  const { askId } = await fxAsk(db, ws);
  const { askRunId } = await fxAskRun(db, ws, askId);
  const { memberId } = await fxAskMember(db, ws, { askId, agent, position: 1, isSpokesperson: true });
  return { ws, agent, askId, askRunId, memberId };
}

/** 汚染されたタスク（集合に urls を入れておく） */
async function taskWith(db: Db, w: World, urls: string[]): Promise<Uuid> {
  const { taskId } = await fxTask(db, w.ws, w.agent, { askId: w.askId, askRunId: w.askRunId, status: "completed", tainted: true });
  await db.transaction((tx) => addTaskWebUrls(tx, w.ws.ctx, taskId, urls.map(h), TASK_WEB_URLS_MAX, NOW));
  return taskId;
}

async function newAskTask(db: Db, w: World, o: { inputTaskIds?: Uuid[]; userUrls?: string[]; inheritFrom?: Uuid[] }): Promise<Uuid> {
  const t = await db.transaction((tx) =>
    insertAskTask(tx, w.ws.ctx, {
      requesterId: w.ws.userId,
      agentId: w.agent.agentId,
      agentSnapshotId: w.agent.snapshotId,
      jobId: w.agent.jobId,
      askId: w.askId,
      askRunId: w.askRunId,
      askMemberId: w.memberId,
      inputTaskIds: o.inputTaskIds ?? [],
      taint: { tainted: (o.inputTaskIds ?? []).length > 0, sources: (o.inputTaskIds ?? []).map((fromTaskId) => ({ kind: "handoff" as const, fromTaskId, fromAgentName: "前の段", upstream: [], at: NOW.toISOString() })) },
      prompt: "依頼の文",
      ...(o.userUrls ? { userWebUrlHashes: o.userUrls.map(h) } : {}),
      ...(o.inheritFrom ? { inheritWebUrlsFrom: o.inheritFrom } : {}),
      now: NOW,
    }),
  );
  return t.id;
}

describe("task_web_urls（SG-04）", () => {
  it("insertAskTask：利用者の文の URL を入れ、受け渡しの元のタスクの集合を写す", async () => {
    const { db } = T();
    const w = await world(db);
    const parent = await taskWith(db, w, ["https://parent.example/found?id=3"]);
    const child = await newAskTask(db, w, { inputTaskIds: [parent], userUrls: ["https://user.example/doc"] });
    expect(await hasTaskWebUrl(db, w.ws.ctx, child, h("https://user.example/doc"))).toBe(true);
    expect(await hasTaskWebUrl(db, w.ws.ctx, child, h("https://parent.example/found?id=3"))).toBe(true);
    expect(await hasTaskWebUrl(db, w.ws.ctx, child, h("https://other.example/"))).toBe(false);
    // 利用者の文も入力もなければ空
    const bare = await newAskTask(db, w, {});
    expect((await db.query("SELECT 1 FROM task_web_urls WHERE task_id = $1", [bare])).rows).toHaveLength(0);
  });

  it("insertFollowupTask：追いのターンは親のタスクの集合を写す", async () => {
    const { db } = T();
    const w = await world(db);
    const parentId = await taskWith(db, w, ["https://parent.example/a", "https://parent.example/b"]);
    const parent = (await getTask(db, w.ws.ctx, parentId))!;
    const follow = await db.transaction((tx) =>
      insertFollowupTask(tx, w.ws.ctx, { parent, messageId: randomUUID(), taint: { tainted: true, sources: parent.taint_sources }, now: NOW }),
    );
    expect(await hasTaskWebUrl(db, w.ws.ctx, follow.id, h("https://parent.example/a"))).toBe(true);
    expect(await hasTaskWebUrl(db, w.ws.ctx, follow.id, h("https://parent.example/b"))).toBe(true);
  });

  it("別のワークスペースからは、同じタスクの id・同じ URL の鍵でも照らせず、写せない", async () => {
    const { db } = T();
    const a = await world(db);
    const b = await world(db, true);
    const url = "https://shared.example/x?id=1";
    const taskA = await taskWith(db, a, [url]);
    // 同じ URL を B のタスクも見ている
    await taskWith(db, b, [url]);
    expect(await hasTaskWebUrl(db, a.ws.ctx, taskA, h(url))).toBe(true);
    expect(await hasTaskWebUrl(db, b.ws.ctx, taskA, h(url))).toBe(false);
    // B のタスクが A のタスクを入力に挙げても、A の集合は写らない
    const childB = await newAskTask(db, b, { inputTaskIds: [taskA] });
    expect(await hasTaskWebUrl(db, b.ws.ctx, childB, h(url))).toBe(false);
    expect(await db.transaction((tx) => copyTaskWebUrls(tx, b.ws.ctx, childB, [taskA], TASK_WEB_URLS_MAX, NOW))).toBe(0);
  });

  it("写すときも上限まで（利用者の文の URL が先に入る）", async () => {
    const { db } = T();
    const w = await world(db);
    const parent = await taskWith(db, w, ["https://p.example/1", "https://p.example/2", "https://p.example/3"]);
    const child = await newAskTask(db, w, { userUrls: ["https://user.example/doc"] });
    expect(await db.transaction((tx) => copyTaskWebUrls(tx, w.ws.ctx, child, [parent], 3, NOW))).toBe(2);
    const n = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM task_web_urls WHERE task_id = $1", [child]);
    expect(n.rows[0]!.n).toBe(3);
    expect(await hasTaskWebUrl(db, w.ws.ctx, child, h("https://user.example/doc"))).toBe(true);
  });

  it("inheritWebUrlsFrom：入力に挙げていない元（返事の前の回答のタスクなど）からも写す。別のワークスペースのタスクからは写らない", async () => {
    const { db } = T();
    const w = await world(db);
    const other = await world(db, true);
    const answer = await taskWith(db, w, ["https://answer.example/seen"]);
    const foreign = await taskWith(db, other, ["https://foreign.example/seen"]);
    const child = await newAskTask(db, w, { inheritFrom: [answer, foreign] });
    expect(await hasTaskWebUrl(db, w.ws.ctx, child, h("https://answer.example/seen"))).toBe(true);
    expect(await hasTaskWebUrl(db, w.ws.ctx, child, h("https://foreign.example/seen"))).toBe(false);
  });
});
