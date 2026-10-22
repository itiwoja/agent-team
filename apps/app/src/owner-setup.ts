// オーナーのワークスペースの初期投入（G-08。冪等。起動時と POST /internal/setup/owner-workspace から呼ぶ）
// 1. 利用者・ワークスペース・所属（db の ensureOwnerWorkspace。監査ログの起点 workspace.created）
// 2. ワークスペースのポリシー v1（kernel の既定。オーナーは per_day_usd 10：M-59）。コネクタは利用者がつなぐ（Google カレンダー・GitHub）
// 2回目は何も変えない（監査ログも増やさない）

import {
  appendAuditLog,
  ensureOwnerWorkspace as ensureOwnerWorkspaceRows,
  lockWorkspace,
  type ConnectorRow,
  type ConnectorToolRow,
  type JsonObject,
  type Uuid,
} from "@open-team/db";
import { insertWorkspacePolicyIfMissing } from "@open-team/db/app";
import { defaultWorkspacePolicy, effectiveArgRoles, hashCanonical, type ConnectorCatalog, type ToolInfo } from "@open-team/kernel";
import type { AppDeps } from "./deps.ts";

/** 投入した行の監査ログの actorId */
export const SEED_ACTOR = "system:seed";

export type OwnerSetupStep = "workspace" | "policy";

/** どの手順で止まったか（呼び出し側のログ・応答に出す。原因は cause） */
export class OwnerSetupError extends Error {
  readonly step: OwnerSetupStep;
  constructor(step: OwnerSetupStep, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OwnerSetupError";
    this.step = step;
  }
}

export interface OwnerSetupResult {
  workspaceId: Uuid;
  ownerUserId: Uuid;
  /** この呼び出しで作ったもの（2回目は全部 false） */
  created: { workspace: boolean; policy: boolean };
}

export type OwnerSetupDeps = Pick<AppDeps, "db" | "clock">;

/** ツールの行から判定の時点の情報（validateAgentDefinition の付与・ガードの確認に使う） */
function toolInfoOf(row: ConnectorToolRow, connectorEnabled: boolean): ToolInfo {
  return {
    classification: row.classification,
    status: row.status,
    connectorEnabled,
    argRoles: effectiveArgRoles(row.input_schema, row.arg_roles),
    scope: row.scope,
    toolHash: row.tool_hash,
  };
}

export function catalogOf(connectors: readonly ConnectorRow[], tools: readonly ConnectorToolRow[]): ConnectorCatalog {
  const out: Record<string, { connected: boolean; tools: Record<string, ToolInfo> }> = {};
  for (const c of connectors) {
    out[c.slug] = {
      connected: c.enabled,
      tools: Object.fromEntries(tools.filter((t) => t.connector_id === c.id).map((t) => [t.name, toolInfoOf(t, c.enabled)])),
    };
  }
  return out;
}

export async function ensureOwnerWorkspace(deps: OwnerSetupDeps, opts: { now?: Date } = {}): Promise<OwnerSetupResult> {
  const now = opts.now ?? deps.clock.now();
  // 1
  const base = await ensureOwnerWorkspaceRows(deps.db, { now }).catch((e: unknown) => {
    throw new OwnerSetupError("workspace", "オーナーのワークスペースを作れなかった", { cause: e });
  });
  const ctx = base.ctx;
  // 2
  const policyCreated = await deps.db
    .transaction(async (tx) => {
      await lockWorkspace(tx, ctx);
      const policy = defaultWorkspacePolicy("owner");
      const policyHash = hashCanonical(policy);
      const p = await insertWorkspacePolicyIfMissing(tx, ctx, { policy: policy as unknown as JsonObject, policyHash, createdBy: null, now });
      if (p.created) {
        await appendAuditLog(
          tx,
          ctx.workspaceId,
          { eventType: "policy.snapshot_created", actorType: "system", actorId: SEED_ACTOR, payload: { scope: "workspace", version: p.row.version, policyHash, origin: "seed" } },
          now,
        );
      }
      return p.created;
    })
    .catch((e: unknown) => {
      throw new OwnerSetupError("policy", "ワークスペースのポリシーを入れられなかった", { cause: e });
    });
  return { workspaceId: ctx.workspaceId, ownerUserId: ctx.userId, created: { workspace: base.created, policy: policyCreated } };
}
