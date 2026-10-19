// SCR-019（チェック）の API：GET /check（見てほしいもの・やっていること・件数）、POST /check/:itemId（報告の ○）、
// GET /done（済んだもの）、GET /counts（SCR-020 の入口の件数）。ワークスペースで必ず絞る（セッションの WsCtx）

import { getCheckMark, insertCheckMark } from "@open-team/db/check";
import { AppError } from "@open-team/platform";
import { z } from "zod";
import { REPORT_KINDS, type CheckMarkResponse, type CheckResponse, type CountsResponse, type DoneResponse } from "../check/contract.ts";
import { publishCheckCounts, publishCheckRemove } from "../check/events.ts";
import { buildCheck, buildDone, reportItemOfKey } from "../check/items.ts";
import type { AppDeps } from "../deps.ts";
import { readQuery, sessionOf } from "../http.ts";
import type { ApiRouter } from "./router.ts";

const CheckQuery = z.object({ item: z.string().max(80).optional() });
const DoneQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.iso.datetime().optional(),
});

/** 行のキーの種類。承認・質問は ○ で消せない（承認は API-019、質問は答える） */
const NOT_CHECKABLE = new Set(["approval", "ask_question", "unknown_outcome"]);
const KEY_RE = /^([a-z_]{1,32}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function checkRoutes(r: ApiRouter, deps: AppDeps): void {
  r.get("/check", async (c) => {
    const s = sessionOf(c);
    const q = readQuery(c, CheckQuery);
    const built = await buildCheck(deps, s, q.item ?? null);
    const killSwitch = await deps.db.query<{ kill_switch_engaged: boolean }>("SELECT kill_switch_engaged FROM workspaces WHERE id = $1", [s.workspaceId]);
    const body: CheckResponse = {
      items: built.items,
      running: built.running,
      counts: built.counts,
      killSwitch: { engaged: killSwitch.rows[0]?.kill_switch_engaged === true },
      focus: q.item !== undefined && built.items.some((i) => i.key === q.item) ? q.item : null,
    };
    return c.json(body);
  });

  r.get("/counts", async (c) => {
    const s = sessionOf(c);
    const body: CountsResponse = (await buildCheck(deps, s)).counts;
    return c.json(body);
  });

  r.get("/done", async (c) => {
    const s = sessionOf(c);
    const q = readQuery(c, DoneQuery);
    const body: DoneResponse = await buildDone(deps, s, { limit: q.limit, before: q.cursor ? new Date(q.cursor) : null });
    return c.json(body);
  });

  // 報告の ○（冪等：すでにチェック済みなら同じ時刻を返す）
  r.post("/check/:itemId", async (c) => {
    const s = sessionOf(c);
    const key = decodeURIComponent(c.req.param("itemId") ?? "").toLowerCase();
    const m = KEY_RE.exec(key);
    if (!m) throw new AppError("VALIDATION_ERROR", undefined, { details: [{ field: "itemId", reason: "行のキーの形ではありません" }] });
    const kind = m[1]!;
    if (NOT_CHECKABLE.has(kind)) throw new AppError("CHECK_ITEM_NOT_CHECKABLE");
    if (!(REPORT_KINDS as readonly string[]).includes(kind)) throw new AppError("NOT_FOUND");
    // 自分のワークスペースにある報告だけ（別のワークスペースの ID は 404）
    if ((await reportItemOfKey(deps, s, key)) === null) throw new AppError("NOT_FOUND");
    const now = deps.clock.now();
    const out = await deps.db.transaction(async (tx) => {
      const inserted = await insertCheckMark(tx, s, key, now);
      if (inserted === null) {
        const at = (await getCheckMark(tx, s, key)) ?? now;
        const counts = (await buildCheck({ db: tx, clock: deps.clock, ids: deps.ids }, s)).counts;
        return { checkedAt: at, counts };
      }
      await publishCheckRemove(tx, s, key, now);
      return { checkedAt: inserted, counts: await publishCheckCounts(tx, deps, s, now) };
    });
    const body: CheckMarkResponse = { key, checkedAt: out.checkedAt.toISOString(), counts: out.counts };
    return c.json(body);
  });
}
