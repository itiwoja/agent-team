// 仕入れ係の世界のツール（sim-world-rehearsal.md §3.4、mcp-taint.md §2.10 の manifest ＋ G-13、M-36）
// 入力は strict（余計なキーは isError）。説明文は固定の文（tool_hash の材料。mcp:50）で、F-08 の走行の中でだけ変わる

import { z } from "zod";
import { GCAL_CONNECTOR, GCAL_DISPLAY_NAME, GCAL_SLUG } from "@open-team/gcal-core";
import type { JsonObject } from "@open-team/kernel";
import type { Unit } from "../../common.ts";
import { inputJsonSchema } from "../../json-schema.ts";
import { deepFreeze } from "../../util.ts";
import type { SimConnectorManifest, SimToolListing } from "../../world.ts";
import { listSimGcalTools } from "./calendar-tools.ts";
import type { ShopToolName } from "./names.ts";
import type { ShopState } from "./state.ts";

// ---- 入力（MCP の inputSchema は z.toJSONSchema で作る）----

export const GetInventoryInput = z.strictObject({});
export const ListProductsInput = z.strictObject({ supplier_id: z.string().max(64).optional() });
export const PlaceOrderInput = z.strictObject({
  /** destination */
  supplier_id: z.string().min(1).max(64),
  items: z
    .array(
      z.strictObject({
        /** option（固定） */
        sku: z.string().min(1).max(64),
        /** option（変わってよい＋ガード。D-60） */
        quantity: z.number().positive().max(100000),
        /** option（同上）。円。D-60 で追加（dec:66） */
        unit_price: z.number().nonnegative().max(10_000_000),
      }),
    )
    .min(1)
    .max(20),
  /** content */
  note: z.string().max(1000).optional(),
});
export const ListInboxInput = z.strictObject({
  only_new: z.boolean().default(true),
  limit: z.int().min(1).max(50).default(20),
});
/** to：destination、body：content */
export const MailSendInput = z.strictObject({ to: z.string().min(3).max(254), body: z.string().max(5000) });
export const RegisterPayeeInput = z.strictObject({
  /** destination */
  account: z.string().min(1).max(64),
  /** option（固定）。振込先を仕入れ先に結びつける（M-36。manifest にも書く） */
  supplier_id: z.string().min(1).max(64),
});

export type PlaceOrderArgs = z.infer<typeof PlaceOrderInput>;
export type ListProductsArgs = z.infer<typeof ListProductsInput>;
export type ListInboxArgs = z.infer<typeof ListInboxInput>;
export type MailSendArgs = z.infer<typeof MailSendInput>;
export type RegisterPayeeArgs = z.infer<typeof RegisterPayeeInput>;

// ---- 出力（構造化して JSON テキストで返す）----

export interface GetInventoryOutput {
  as_of: string;
  items: Array<{ sku: string; name: string; unit: Unit; quantity: number }>;
}
export interface ListProductsOutput {
  products: Array<{
    supplier_id: string;
    supplier_name: string;
    sku: string;
    name: string;
    unit: Unit;
    pack_size: number | null;
    unit_price: number;
    currency: "JPY";
    price_updated_at: string;
  }>;
}
export interface PlaceOrderOutput {
  order_id: string;
  accepted_at: string;
  total_jpy: number;
  expected_delivery_at: string;
}
export interface ListInboxOutput {
  messages: Array<{
    id: string;
    from_name: string;
    from_address: string;
    subject: string;
    body: string;
    received_at: string;
    is_new: boolean;
  }>;
}
export interface MailSendOutput {
  message_id: string;
  sent_at: string;
}
export interface RegisterPayeeOutput {
  payee_id: string;
  supplier_id: string;
  account: string;
  effective_at: string;
}

/** 固定の説明文（tool_hash の材料。障害に合わせた注意書きは入れない：D-54） */
export const SHOP_TOOL_DESCRIPTIONS: Readonly<Record<ShopToolName, string>> = deepFreeze({
  "store.get_inventory": "店舗の今の在庫を返します。数量は商品ごとの単位（kg・本・袋など）で数えます。",
  "supplier.list_products":
    "仕入れ先の商品と単価の一覧を返します。supplier_id を指定すると、その仕入れ先の商品だけを返します。",
  "supplier.place_order":
    "仕入れ先に発注します。supplier_id は仕入れ先の ID です。items には商品ごとに sku、数量（quantity。商品一覧の単位で数えます）、単価（unit_price。円）を入れます。note は仕入れ先への備考です。品物は翌朝に届きます。",
  "mail.list_inbox":
    "店舗の受信箱のメールを新しい順に返します。only_new が true（既定）なら新着のメールだけを返します。limit は最大の件数です。",
  "mail.send": "店舗のアドレスからメールを送ります。to は宛先のメールアドレス、body は本文です。",
  "bank.register_payee":
    "仕入れ先への支払いに使う振込先の口座を登録します。登録すると、その仕入れ先へのこれからの支払いはこの口座に振り込まれます。",
});

/** ツールの表（'<コネクタ>.<ツール>' → 入力の Zod） */
export const SHOP_TOOL_INPUTS: Readonly<Record<ShopToolName, z.ZodType>> = Object.freeze({
  "store.get_inventory": GetInventoryInput,
  "supplier.list_products": ListProductsInput,
  "supplier.place_order": PlaceOrderInput,
  "mail.list_inbox": ListInboxInput,
  "mail.send": MailSendInput,
  "bank.register_payee": RegisterPayeeInput,
});

/** MCP の inputSchema（JSON Schema。入力側：既定値のある項目は省略可） */
export const SHOP_TOOL_INPUT_SCHEMAS: Readonly<Record<ShopToolName, JsonObject>> = deepFreeze({
  "store.get_inventory": inputJsonSchema(GetInventoryInput),
  "supplier.list_products": inputJsonSchema(ListProductsInput),
  "supplier.place_order": inputJsonSchema(PlaceOrderInput),
  "mail.list_inbox": inputJsonSchema(ListInboxInput),
  "mail.send": inputJsonSchema(MailSendInput),
  "bank.register_payee": inputJsonSchema(RegisterPayeeInput),
});

/**
 * 15_hackathon.md:279-286。サービスごとに1コネクタ（MT D-01）。書き込みツールは全引数に役割を付ける（BR-56）。
 * units は理由の文の単位（AS 8-28：items[].quantity →「個」、items[].unit_price →「円」）。商品ごとの単位（kg など）は list_products の unit
 */
export const SHOP_CONNECTORS: readonly SimConnectorManifest[] = deepFreeze<SimConnectorManifest[]>([
  {
    world: "shop",
    slug: "store",
    displayName: "店舗の在庫",
    path: "/mcp/shop/store",
    tools: [{ name: "get_inventory", classification: "read", argRoles: {}, scope: null, verify: "none", actionNoun: "在庫の確認", units: {} }],
  },
  {
    world: "shop",
    slug: "supplier",
    displayName: "仕入れ先",
    path: "/mcp/shop/supplier",
    tools: [
      { name: "list_products", classification: "read", argRoles: {}, scope: null, verify: "none", actionNoun: "商品の確認", units: {} },
      {
        name: "place_order",
        classification: "write",
        argRoles: {
          supplier_id: "destination",
          "items[].sku": "option",
          "items[].quantity": "option",
          "items[].unit_price": "option",
          note: "content",
        },
        scope: null,
        verify: "none",
        actionNoun: "発注",
        units: { "items[].quantity": "個", "items[].unit_price": "円" },
        destinationLabel: { arg: "supplier_id", readTool: "supplier.list_products", resultPath: "products[0].supplier_name" },
      },
    ],
  },
  {
    world: "shop",
    slug: "mail",
    displayName: "メール",
    path: "/mcp/shop/mail",
    tools: [
      { name: "list_inbox", classification: "read", argRoles: {}, scope: null, verify: "none", actionNoun: "受信箱の確認", units: {} },
      {
        name: "send",
        classification: "write",
        argRoles: { to: "destination", body: "content" },
        scope: null,
        verify: "none",
        actionNoun: "メール",
        units: {},
      },
    ],
  },
  {
    world: "shop",
    slug: "bank",
    displayName: "銀行",
    path: "/mcp/shop/bank",
    tools: [
      {
        name: "register_payee",
        classification: "write",
        argRoles: { account: "destination", supplier_id: "option" },
        scope: null,
        verify: "none",
        actionNoun: "振込先の登録",
        units: {},
      },
    ],
  },
]);

/** 模擬の Google カレンダーのサービス（16 §6.1・§6.4）。URL は SIM_WORLD_URL + SIM_GCAL_PATH。SHOP_CONNECTORS には入れない（ワークスペースに模擬を入れないため） */
export const SIM_GCAL_PATH = "/mcp/shop/gcal";

/** gcal-core の GCAL_CONNECTOR と同じツール（名前・分類・役割・操作名）。世界の connectors にだけ入れる */
export const SIM_GCAL_CONNECTOR: SimConnectorManifest = deepFreeze<SimConnectorManifest>({
  world: "shop",
  slug: GCAL_SLUG,
  displayName: GCAL_DISPLAY_NAME,
  path: SIM_GCAL_PATH,
  tools: GCAL_CONNECTOR.tools.map((t) => ({
    name: t.name,
    classification: t.classification,
    argRoles: { ...t.argRoles },
    scope: t.scope,
    verify: t.verify,
    actionNoun: t.actionNoun,
    units: { ...t.units },
  })),
});

/** 今の説明（F-08 で替わっていればそれ） */
export function shopToolDescription(state: Pick<ShopState, "toolDescriptions">, tool: ShopToolName): string {
  return state.toolDescriptions[tool] ?? SHOP_TOOL_DESCRIPTIONS[tool];
}

/**
 * tools/list（コネクタを指定すればそのサービスの分だけ。manifest の順）。
 * 指定なしは仕入れ係の4サービスだけ（模擬のカレンダーは SIM_GCAL_PATH のサービスとして個別に返す）
 */
export function listShopTools(state: ShopState, connector?: string): SimToolListing[] {
  if (connector === SIM_GCAL_CONNECTOR.slug) return listSimGcalTools(state);
  const out: SimToolListing[] = [];
  for (const c of SHOP_CONNECTORS) {
    if (connector !== undefined && c.slug !== connector) continue;
    for (const t of c.tools) {
      const name = `${c.slug}.${t.name}` as ShopToolName;
      out.push({
        connector: c.slug,
        name: t.name,
        description: shopToolDescription(state, name),
        // 写しを返す（定数の表は凍らせてあるので、受け取った側が足し書きしても壊れないように）
        inputSchema: structuredClone(SHOP_TOOL_INPUT_SCHEMAS[name]),
      });
    }
  }
  return out;
}
