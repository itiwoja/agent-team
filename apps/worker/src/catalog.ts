// コネクタとツールの行から、判定の時点のカタログ（Kernel の ConnectorCatalog）を作る。
// apps/app/src/owner-setup.ts の catalogOf（と toolInfoOf）だけを写したもの（中身は同じ）。
// オーナーのワークスペースの初期投入（ensureOwnerWorkspace）は WorkspaceDO の init が受け持つので写さない

import { effectiveArgRoles, type ConnectorCatalog, type ToolInfo } from "@open-team/kernel";
import type { ConnectorRow, ConnectorToolRow } from "./db/types.ts";

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
