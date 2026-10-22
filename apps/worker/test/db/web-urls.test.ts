// タスクが見た URL の集合（SG-04・task_web_urls）の試験（packages/db/src/web-urls.test.ts の WorkspaceDO 版）。
// タスクを作るときに利用者の文の URL を入れ、汚染を引き継ぐ元の集合を写す。ワークスペースをまたぐ試験は DO では起きないので落とした
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CODECS } from "../../src/db/codecs.ts";
import { insertAskTask, insertFollowupTask } from "../../src/db/repo/asks.ts";
import { addTaskWebUrls, copyTaskWebUrls, hasTaskWebUrl, TASK_WEB_URLS_MAX } from "../../src/db/repo/web-urls.ts";
import { count, one, type WsDb } from "../../src/db/sqlite.ts";
import type { TaskRow, Uuid } from "../../src/db/types.ts";
import { fxAgent, fxAsk, fxAskMember, fxAskRun, fxTask, inWorkspace, type FxAgent, type FxWorkspace } from "./fixtures.ts";

const NOW = new Date("2026-10-15T09:00:00.000Z");
const h = (url: string): string => createHash("sha256").update(url, "utf8").digest("hex");

interface World {
  ws: FxWorkspace;
  agent: FxAgent;
  askId: Uuid;
  askRunId: Uuid;
  memberId: Uuid;
}

function world(db: WsDb, ws: FxWorkspace): World {
  const agent = fxAgent(db);
  const { askId } = fxAsk(db, ws);
  const { askRunId } = fxAskRun(db, askId);
  const { memberId } = fxAskMember(db, { askId, agent, position: 1, isSpokesperson: true });
  return { ws, agent, askId, askRunId, memberId };
}

/** 汚染されたタスク（集合に urls を入れておく） */
function taskWith(db: WsDb, w: World, urls: string[]): Uuid {
  const { taskId } = fxTask(db, w.ws, w.agent, { askId: w.askId, askRunId: w.askRunId, status: "completed", tainted: true });
  addTaskWebUrls(db, taskId, urls.map(h), TASK_WEB_URLS_MAX, NOW);
  return taskId;
}

function newAskTask(db: WsDb, w: World, o: { inputTaskIds?: Uuid[]; userUrls?: string[]; inheritFrom?: Uuid[] }): Uuid {
  const inputs = o.inputTaskIds ?? [];
  const t = insertAskTask(db, {
    requesterId: w.ws.userId,
    agentId: w.agent.agentId,
    agentSnapshotId: w.agent.snapshotId,
    jobId: w.agent.jobId,
    askId: w.askId,
    askRunId: w.askRunId,
    askMemberId: w.memberId,
    inputTaskIds: inputs,
    taint: {
      tainted: inputs.length > 0,
      sources: inputs.map((fromTaskId) => ({ kind: "handoff" as const, fromTaskId, fromAgentName: "前の段", upstream: [], at: NOW.toISOString() })),
    },
    prompt: "依頼の文",
    ...(o.userUrls ? { userWebUrlHashes: o.userUrls.map(h) } : {}),
    ...(o.inheritFrom ? { inheritWebUrlsFrom: o.inheritFrom } : {}),
    now: NOW,
  });
  return t.id;
}

describe("task_web_urls（SG-04）", () => {
  it("insertAskTask：利用者の文の URL を入れ、受け渡しの元のタスクの集合を写す", async () => {
    await inWorkspace((db, ws) => {
      const w = world(db, ws);
      const parent = taskWith(db, w, ["https://parent.example/found?id=3"]);
      const child = newAskTask(db, w, { inputTaskIds: [parent], userUrls: ["https://user.example/doc"] });
      expect(hasTaskWebUrl(db, child, h("https://user.example/doc"))).toBe(true);
      expect(hasTaskWebUrl(db, child, h("https://parent.example/found?id=3"))).toBe(true);
      expect(hasTaskWebUrl(db, child, h("https://other.example/"))).toBe(false);
      // 利用者の文も入力もなければ空
      const bare = newAskTask(db, w, {});
      expect(count(db, "SELECT count(*) FROM task_web_urls WHERE task_id = ?", bare)).toBe(0);
    });
  });

  it("insertFollowupTask：追いのターンは親のタスクの集合を写す", async () => {
    await inWorkspace((db, ws) => {
      const w = world(db, ws);
      const parentId = taskWith(db, w, ["https://parent.example/a", "https://parent.example/b"]);
      const parent = one<TaskRow>(db, CODECS.tasks, "SELECT * FROM tasks WHERE id = ?", parentId)!;
      const follow = insertFollowupTask(db, { parent, messageId: randomUUID(), taint: { tainted: true, sources: parent.taint_sources }, now: NOW });
      expect(follow).toMatchObject({ kind: "followup", parent_task_id: parentId, tainted: true, status: "queued" });
      expect(hasTaskWebUrl(db, follow.id, h("https://parent.example/a"))).toBe(true);
      expect(hasTaskWebUrl(db, follow.id, h("https://parent.example/b"))).toBe(true);
    });
  });

  it("足すのは上限まで。すでにある鍵・同じ鍵の重なりは数えない", async () => {
    await inWorkspace((db, ws) => {
      const w = world(db, ws);
      const { taskId } = fxTask(db, ws, w.agent);
      expect(addTaskWebUrls(db, taskId, [h("a"), h("a"), h("b")], 3, NOW)).toBe(2);
      expect(addTaskWebUrls(db, taskId, [h("b"), h("c"), h("d")], 3, NOW)).toBe(1);
      expect(count(db, "SELECT count(*) FROM task_web_urls WHERE task_id = ?", taskId)).toBe(3);
      expect(hasTaskWebUrl(db, taskId, h("d"))).toBe(false);
      expect(() => addTaskWebUrls(db, taskId, ["xyz"], 3, NOW)).toThrow(TypeError);
      expect(hasTaskWebUrl(db, taskId, "xyz")).toBe(false);
    });
  });

  it("写すときも上限まで（利用者の文の URL が先に入る）", async () => {
    await inWorkspace((db, ws) => {
      const w = world(db, ws);
      const parent = taskWith(db, w, ["https://p.example/1", "https://p.example/2", "https://p.example/3"]);
      const child = newAskTask(db, w, { userUrls: ["https://user.example/doc"] });
      expect(copyTaskWebUrls(db, child, [parent], 3, NOW)).toBe(2);
      expect(count(db, "SELECT count(*) FROM task_web_urls WHERE task_id = ?", child)).toBe(3);
      expect(hasTaskWebUrl(db, child, h("https://user.example/doc"))).toBe(true);
      expect(copyTaskWebUrls(db, child, [parent], 3, NOW)).toBe(0);
    });
  });

  it("inheritWebUrlsFrom：入力に挙げていない元（返事の前の回答のタスクなど）からも写す", async () => {
    await inWorkspace((db, ws) => {
      const w = world(db, ws);
      const answer = taskWith(db, w, ["https://answer.example/seen"]);
      const child = newAskTask(db, w, { inheritFrom: [answer] });
      expect(hasTaskWebUrl(db, child, h("https://answer.example/seen"))).toBe(true);
    });
  });
});
