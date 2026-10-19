// 事象に走行の中の通し番号を振る（中だけで使う。index からは出さない）

import type { SimEvent } from "../../world.ts";
import type { ShopState } from "./state.ts";

/** 状態の eventSeq を進めて番号を振る（状態は呼び出し側の写しを書き換える） */
export function numberedEvent(s: ShopState, e: Omit<SimEvent, "seq">): SimEvent {
  s.eventSeq += 1;
  return { seq: s.eventSeq, ...e };
}
