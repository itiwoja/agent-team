// sim-world が動かす世界（15:275「世界の登録・状態の分け方・障害の注入は共通にし、あとで世界を足すだけ」）
// 中身まで動く世界だけをここに置く（Must は shop だけ。brief・repo は sim-core の枠だけなので MCP も管理 API も受けない）

import { SHOP_WORLD, WORLD_IDS, type SimConnectorManifest, type WorldDefinition, type WorldId } from "@open-team/sim-core";

/** 状態の型を問わない世界（状態は jsonb で持ち、その世界の関数にだけ渡す） */
export type AnyWorld = WorldDefinition<unknown>;
export type WorldRegistry = Readonly<Partial<Record<WorldId, AnyWorld>>>;

export const DEFAULT_WORLDS: WorldRegistry = Object.freeze({ shop: SHOP_WORLD });

export function isWorldId(value: string): value is WorldId {
  return (WORLD_IDS as readonly string[]).includes(value);
}

/** URL・本文の世界 ID から動く世界を引く（知らない・枠だけの世界は null） */
export function implementedWorld(worlds: WorldRegistry, id: string): AnyWorld | null {
  if (!isWorldId(id)) return null;
  const w = worlds[id];
  return w && w.implemented ? w : null;
}

/** URL のサービス（/mcp/<world>/<service>）のコネクタ（MT D-01：サービスごとに1コネクタ） */
export function connectorOf(world: AnyWorld, service: string): SimConnectorManifest | null {
  return world.connectors.find((c) => c.slug === service) ?? null;
}

const baseStates = new WeakMap<AnyWorld, unknown>();

/**
 * 走行のまだない所の tools/list に使う基準の状態（説明は固定の文のまま）。デモ店舗はコネクタの登録（tools/list）より
 * 後に作られることがある（G-08 の順）ので、その間も固定の説明を返す
 */
export function baseStateOf(world: AnyWorld): unknown {
  let s = baseStates.get(world);
  if (s === undefined) {
    s = world.createInitialState(0, { seedVersion: world.seedVersion });
    baseStates.set(world, s);
  }
  return s;
}
