// 仕入れ係の世界のツール名と使える障害（15:279-286。表記は '<コネクタ>.<ツール>'。操作名はその前に 'mcp.'）

export const SHOP_READ_TOOLS = ["store.get_inventory", "supplier.list_products", "mail.list_inbox"] as const;
export const SHOP_WRITE_TOOLS = ["supplier.place_order", "mail.send", "bank.register_payee"] as const;
export const SHOP_TOOL_NAMES = [...SHOP_READ_TOOLS, ...SHOP_WRITE_TOOLS] as const;
export type ShopReadToolName = (typeof SHOP_READ_TOOLS)[number];
export type ShopWriteToolName = (typeof SHOP_WRITE_TOOLS)[number];
export type ShopToolName = ShopReadToolName | ShopWriteToolName;

/** 仕入れ係の世界で注入できる障害（F-01〜08。15:104、dec:59。F-14 は Web の取得・検索（リハーサル）で足した。F-15〜17 は模擬のカレンダー：16 §6.3） */
export const SHOP_SUPPORTED_FAULTS = [
  "F-01",
  "F-02",
  "F-03",
  "F-04",
  "F-05",
  "F-06",
  "F-07",
  "F-08",
  "F-14",
  "F-15",
  "F-16",
  "F-17",
] as const;

/** 模擬のカレンダーの障害（16 §6.4）。F-15 の時刻の取り違え・F-16 の古い空き・F-17 の既存の予定への指示 */
export const GCAL_CALENDAR_FAULTS = ["F-15", "F-16", "F-17"] as const;

/** 模擬のカレンダーのツール（'gcal.<ツール>'。16 §6.2。名前と分類は gcal-core の GCAL_CONNECTOR と同じ） */
export const SIM_GCAL_READ_TOOLS = ["gcal.find_free_time", "gcal.list_events"] as const;
export const SIM_GCAL_WRITE_TOOLS = ["gcal.create_event", "gcal.delete_event"] as const;
export const SIM_GCAL_TOOL_NAMES = [...SIM_GCAL_READ_TOOLS, ...SIM_GCAL_WRITE_TOOLS] as const;
export type SimGcalToolName = (typeof SIM_GCAL_TOOL_NAMES)[number];

export function isSimGcalToolName(name: string): name is SimGcalToolName {
  return (SIM_GCAL_TOOL_NAMES as readonly string[]).includes(name);
}

export function isSimGcalWriteTool(name: string): boolean {
  return (SIM_GCAL_WRITE_TOOLS as readonly string[]).includes(name);
}

export function isShopToolName(name: string): name is ShopToolName {
  return (SHOP_TOOL_NAMES as readonly string[]).includes(name);
}

export function isShopWriteTool(name: string): name is ShopWriteToolName {
  return (SHOP_WRITE_TOOLS as readonly string[]).includes(name);
}
