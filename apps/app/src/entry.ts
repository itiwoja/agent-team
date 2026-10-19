// EP-01 入口（POST /api/v1/entry。AS §3.1、SO §3.4、DB §4.3、D-06・D-39）
// 1. トークンは本文だけから読む（URL・ヘッダーから読まない：15:338）。ログに出さない
// 2. オーナー用とゲスト用の両方と定数時間で比べてから分岐する（どちらに一致したかを時間から漏らさない：SO-ENT-12）
// 3. どちらでもない → entry_attempts(wrong_token)。直近10分の失敗が5件目から 1・2・4・8・10秒待たせて 401 UNAUTHORIZED
//    （429 にしない：同じ回線の審査員を締め出さない。M-55）
// 4. 前のセッションの Cookie があれば失効させる（SO §3.4 の5。ワークスペースは消さない）
// 5. オーナー → オーナーのワークスペース（なければ作る：D-05）とその owner でセッションを作る → entry_attempts(owner)
// 6. 審査用 → 入れるたびに新しいゲストのワークスペースを作り、デモ用のデータを入れてセッションを作る（guest-seed.ts：FR-046・D-39）。
//    作成の上限（BR-65）に当たったら 429 GUEST_LIMIT_REACHED。応答に最初に開く依頼（firstAskId。D-69）を含める

import { ensureOwnerWorkspace as ensureOwnerWorkspaceRows, issueSession, revokeSession, system, type IssuedSession, type SessionCtx, type Uuid } from "@open-team/db";
import { safeEqual } from "@open-team/platform";
import type { AppDeps } from "./deps.ts";
import { enterAsNewGuest } from "./guest-seed.ts";

export type EntryResult =
  | { kind: "owner"; session: IssuedSession; workspaceId: Uuid }
  | { kind: "guest"; session: IssuedSession; workspaceId: Uuid; firstAskId: Uuid }
  | { kind: "guest_limit"; scope: "global" | "ip" }
  | { kind: "wrong_token"; delayMs: number };

/** 設定されていないトークンの代わりに比べる値（一致しない。比べる回数と時間をそろえるためだけ） */
const UNSET_TOKEN = "\u0000open-team:unset-entry-token\u0000";

/**
 * 入口のトークンの照合。オーナー用・ゲスト用の両方を必ず比べてから返す（SO §3.4 の3）。
 * compare は試験で差し替える（既定は platform の safeEqual：両方を HMAC してから timingSafeEqual）
 */
export function matchEntryToken(
  token: string,
  expected: { owner: string | undefined; guest: string | undefined },
  compare: (input: string, expected: string) => boolean = safeEqual,
): { isOwner: boolean; isGuest: boolean } {
  const isOwner = compare(token, expected.owner ?? UNSET_TOKEN) && expected.owner !== undefined;
  const isGuest = compare(token, expected.guest ?? UNSET_TOKEN) && expected.guest !== undefined;
  return { isOwner, isGuest };
}

export interface EntryRequest {
  token: string;
  ip: string;
  userAgent: string | null;
  /** 今の有効なセッション（あれば失効させる） */
  existing: SessionCtx | null;
}

export async function enter(deps: Pick<AppDeps, "db" | "env" | "log" | "clock" | "sleep" | "gatewayClient" | "simClient" | "ids">, req: EntryRequest): Promise<EntryResult> {
  const now = deps.clock.now();
  const { isOwner, isGuest } = matchEntryToken(req.token, { owner: deps.env.ownerToken, guest: deps.env.guestToken });
  // 準備中の確認を通ったあとなので鍵はある（なければ IP を残さない）
  const ipHash = deps.env.cookieSecret ? system.hashIp(req.ip, deps.env.cookieSecret) : null;

  if (!isOwner && !isGuest) {
    let delayMs = 0;
    if (ipHash) {
      const r = await system.recordWrongToken(deps.db, { ipHash, now });
      delayMs = r.delayMs;
      deps.log.info("entry.wrong_token", "入口のトークンが違う", { ipHash, failures: r.failures, delayMs });
    }
    if (delayMs > 0) await deps.sleep(delayMs);
    return { kind: "wrong_token", delayMs };
  }

  if (!isOwner) {
    const g = await enterAsNewGuest(deps, { ipHash, userAgent: req.userAgent, existing: req.existing });
    if (g.kind === "guest_limit") {
      deps.log.info("entry.guest_limit", "ゲストの作成の上限に当たった", { ipHash, scope: g.scope });
    }
    return g;
  }

  return enterAsOwner(deps, { ipHash, userAgent: req.userAgent, existing: req.existing, now });
}

/**
 * オーナーとして入る（トークンが一致したあと、またはローカルのトークンなしの入口：routes/session.ts の POST /entry/local）。
 * オーナーのワークスペース（なければ作る）でセッションを作り、前のセッションを失効させる
 */
export async function enterAsOwner(
  deps: Pick<AppDeps, "db" | "log">,
  req: { ipHash: string | null; userAgent: string | null; existing: SessionCtx | null; now: Date; via?: "token" | "local" },
): Promise<Extract<EntryResult, { kind: "owner" }>> {
  const { ipHash, now } = req;
  const out = await deps.db.transaction(async (tx) => {
    const { ctx } = await ensureOwnerWorkspaceRows(tx, { now });
    if (req.existing) await revokeSession(tx, req.existing, now);
    const session = await issueSession(tx, { workspaceId: ctx.workspaceId, userId: ctx.userId, ipHash, userAgent: req.userAgent, now });
    if (ipHash) await system.recordEntryAttempt(tx, { ipHash, outcome: "owner", workspaceId: ctx.workspaceId, now });
    return { session, workspaceId: ctx.workspaceId };
  });
  deps.log.info("entry.owner", "オーナーが入った", { workspaceId: out.workspaceId, ipHash, via: req.via ?? "token" });
  return { kind: "owner", ...out };
}
