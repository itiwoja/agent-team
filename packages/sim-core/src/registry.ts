// 世界の登録（15:275「あとで世界を足すだけにする」）。Must は shop だけ。brief・repo は枠だけ（manifest と supportedFaults）

import type { WorldId } from "./common.ts";
import type { WorldFrame } from "./world.ts";
import { BRIEF_FRAME, REPO_FRAME } from "./worlds/frames.ts";
import { SHOP_WORLD } from "./worlds/shop/index.ts";

export const WORLDS = Object.freeze({ shop: SHOP_WORLD, brief: BRIEF_FRAME, repo: REPO_FRAME }) satisfies Readonly<
  Record<WorldId, WorldFrame>
>;

export function worldFrame(id: WorldId): WorldFrame {
  return WORLDS[id];
}

/** 中身まで動く世界か（枠だけの世界には状況を走らせない） */
export function isWorldImplemented(id: WorldId): boolean {
  return WORLDS[id].implemented;
}
