// コネクタのツールの分類（MT §3.14 の7、16 §3.6）。manifest（slug・ツールの分類・引数の役割）を、
// gateway の同期で入った connector_tools の行に確定する。owner-setup（sim-world）と Google カレンダーの接続が同じ処理を使う
// 決めたこと：
// - needs_review のツールは触らない（持ち主の確認が要る。needsReview に積む）
// - 引数の役割が入力スキーマと合わなければ ManifestError（呼び出し側が手順の名前をつけて例外にする）
// - 監査ログは呼び出し側が書く（audit のコールバック。トランザクションの中で呼ぶ）

import { lockWorkspace, type ConnectorRow, type ConnectorToolRow, type JsonObject, type Tx, type Uuid, type WsCtx } from "@open-team/db";
import { applyToolClassification, listConnectorTools } from "@open-team/db/app";
import { toolHashOf, validateArgRoleKeys, type ArgRoleMap, type ToolClassification, type ToolScope } from "@open-team/kernel";

/** 分類の約束（manifest の1ツール）。SimToolManifest・GcalToolManifest が満たす */
export interface ClassifiableTool {
  name: string;
  classification: ToolClassification;
  argRoles: ArgRoleMap;
  scope: ToolScope;
  verify: "none" | "readback";
}

export interface ClassifiableManifest {
  slug: string;
  tools: readonly ClassifiableTool[];
}

/** manifest と DB の行が合わない（呼び出し側が手順の名前をつけて扱う） */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

export interface ClassifyInput {
  manifests: readonly ClassifiableManifest[];
  /** manifest の slug に対応するコネクタの行（ここにある slug だけ見る） */
  connectors: readonly ConnectorRow[];
  classifiedBy: string;
  now: Date;
  /** 変わったツールごとに呼ぶ（トランザクションの中。監査ログを書く） */
  audit(tx: Tx, eventType: string, payload: JsonObject): Promise<void>;
}

export interface ClassifyResult {
  /** この呼び出しで分類を変えたツール（"<slug>.<name>"） */
  classified: string[];
  /** needs_review のまま確定しなかったツール（持ち主の確認が要る：MT §3.13.2） */
  needsReview: string[];
  /** コネクタごとのツールの数（DB の行の数） */
  connectorTools: Array<{ slug: string; id: Uuid; tools: number }>;
}

const actionOf = (connector: string, tool: string) => `${connector}.${tool}`;

/** 呼び出し側のトランザクションの中で呼ぶ（ワークスペースの行をここで取る） */
export async function classifyConnectorTools(tx: Tx, ctx: WsCtx, input: ClassifyInput): Promise<ClassifyResult> {
  await lockWorkspace(tx, ctx);
  const connectorRows = input.connectors;
  const tools: ConnectorToolRow[] = await listConnectorTools(
    tx,
    ctx,
    connectorRows.map((c) => c.id),
  );
  const classified: string[] = [];
  const needsReview: string[] = [];
  for (const m of input.manifests) {
    const connector = connectorRows.find((c) => c.slug === m.slug);
    if (!connector) throw new ManifestError(`コネクタがない：${m.slug}`);
    for (const t of m.tools) {
      const name = actionOf(m.slug, t.name);
      const row = tools.find((x) => x.connector_id === connector.id && x.name === t.name);
      if (!row) throw new ManifestError(`manifest のツールが tools/list にない：${name}`);
      if (row.status === "needs_review") {
        needsReview.push(name);
        continue;
      }
      const keys = validateArgRoleKeys(row.input_schema, t.argRoles);
      if (!keys.ok) {
        throw new ManifestError(`manifest の引数の役割が入力スキーマと合わない：${name}（${keys.errors.map((e) => `${e.path}:${e.reason}`).join(", ")}）`);
      }
      const toolHash = toolHashOf({ description: row.description, inputSchema: row.input_schema, argRoles: t.argRoles });
      const changed = await applyToolClassification(tx, ctx, row.id, {
        classification: t.classification,
        argRoles: t.argRoles,
        scope: t.scope,
        verify: t.verify,
        toolHash,
        classifiedBy: input.classifiedBy,
        now: input.now,
      });
      if (changed) {
        classified.push(name);
        await input.audit(tx, "connector.tool.classified", {
          connectorId: connector.id,
          tool: t.name,
          classification: t.classification,
          argRoles: t.argRoles as JsonObject,
          toolHash,
        });
      }
    }
  }
  return {
    classified,
    needsReview,
    connectorTools: connectorRows.map((c) => ({ slug: c.slug, id: c.id, tools: tools.filter((t) => t.connector_id === c.id).length })),
  };
}
