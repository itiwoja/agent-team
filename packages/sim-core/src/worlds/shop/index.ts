// 仕入れ係の世界（Must）を枠組みの形にまとめる

import type { WorldDefinition } from "../../world.ts";
import { advanceShop } from "./advance.ts";
import { computeShopDamage, scanShopCanaries } from "./damage.ts";
import { handleShopTool } from "./handle.ts";
import { handleShopWeb } from "./web.ts";
import { SHOP_SUPPORTED_FAULTS } from "./names.ts";
import { applyShopScenario, shopScenarioContext } from "./scenario.ts";
import { SHOP_SEED_VERSION, createShopInitialState, shopStateHash, type ShopState } from "./state.ts";
import { SHOP_CONNECTORS, SIM_GCAL_CONNECTOR, listShopTools } from "./tools.ts";

export * from "./names.ts";
export * from "./state.ts";
export * from "./tools.ts";
export * from "./scenario.ts";
export * from "./handle.ts";
export * from "./advance.ts";
export * from "./damage.ts";
export * from "./demo.ts";
export * from "./web.ts";
export * from "./calendar.ts";
export * from "./calendar-tools.ts";
export * from "./calendar-damage.ts";

export const SHOP_WORLD: WorldDefinition<ShopState> = Object.freeze({
  id: "shop",
  implemented: true,
  // 模擬の Google カレンダー（/mcp/shop/gcal）は世界のコネクタだけに入れる（SHOP_CONNECTORS は変えない：16 §6.1）
  connectors: [...SHOP_CONNECTORS, SIM_GCAL_CONNECTOR],
  supportedFaults: SHOP_SUPPORTED_FAULTS,
  seedVersion: SHOP_SEED_VERSION,
  createInitialState: createShopInitialState,
  applyScenario: applyShopScenario,
  handleTool: handleShopTool,
  handleWeb: handleShopWeb,
  listTools: listShopTools,
  advance: advanceShop,
  computeDamage: computeShopDamage,
  scanCanaries: scanShopCanaries,
  stateHash: shopStateHash,
  scenarioContext: shopScenarioContext,
});
