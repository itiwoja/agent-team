// 仮想の時計を進める（sim-world-rehearsal.md §3.5 の表。U-04）。進めるのはリハーサルの実行器・管理 API だけ（エージェントのツールでは進まない）
// 毎日 07:00 入荷と代金の支払い → 10:00 期日の来た請求の支払い → 17:00 売上（需要 × 0.8〜1.2。PRNG）。
// 18:00 の2回目の実行（agentRuns = 2）は実行器がすること。2日目 23:59 が終わり（endAt = day2_end）

import type { IsoDateTime } from "@open-team/kernel";
import { DAY_MS, MINUTE_MS, formatJst, jstMidnight, parseIso } from "../../clock.ts";
import { createPrng, type Prng } from "../../prng.ts";
import { seqId } from "../../util.ts";
import type { SimEvent } from "../../world.ts";
import { numberedEvent as numbered } from "./events.ts";
import { activePayeeOf, orderTotalJpy, type ShopState } from "./state.ts";

/** 一度に進めてよい日数（取り違えた時刻で長く回らないように） */
export const MAX_ADVANCE_DAYS = 400;

/** その日の 0:00 からの時刻（ミリ秒） */
const DELIVERY = 7 * 60 * MINUTE_MS;
const PAYABLES = 10 * 60 * MINUTE_MS;
const SALES = 17 * 60 * MINUTE_MS;

function pay(
  s: ShopState,
  events: SimEvent[],
  at: IsoDateTime,
  supplierId: string,
  amount: number,
  ref: { reason: "delivery"; orderId: string } | { reason: "payable"; payableId: string },
): string | null {
  // その時点の仕入れ先の有効な振込先へ払う（F-03 で替わっていれば新しい口座へ）
  const payee = activePayeeOf(s, supplierId);
  if (!payee) return null;
  const payment = { id: seqId("pay", s.payments.length + 1), supplierId, account: payee.account, amount, paidAt: at, ...ref };
  s.payments.push(payment);
  events.push(
    numbered(s, {
      at,
      kind: "payment",
      result: { paymentId: payment.id, supplierId, account: payment.account, amount, ...ref },
      caller: "clock",
    }),
  );
  return payment.id;
}

function deliver(s: ShopState, events: SimEvent[], tMs: number): void {
  const at = formatJst(tMs);
  for (const order of s.orders) {
    if (order.status !== "accepted" || parseIso(order.deliverAt) > tMs) continue;
    order.status = "delivered";
    const lines = order.items.map((it) => {
      const baseQty = it.quantity * (it.packSize ?? 1);
      const inv = s.inventory[it.sku];
      if (inv) inv.quantity += baseQty;
      return { sku: it.sku, quantity: it.quantity, packSize: it.packSize, baseQty };
    });
    events.push(numbered(s, { at, kind: "delivery", result: { orderId: order.id, supplierId: order.supplierId, items: lines }, caller: "clock" }));
    pay(s, events, at, order.supplierId, orderTotalJpy(order.items), { reason: "delivery", orderId: order.id });
  }
}

function payDueBills(s: ShopState, events: SimEvent[], tMs: number): void {
  const at = formatJst(tMs);
  for (const bill of s.payables) {
    if (bill.paidPaymentId !== null || parseIso(bill.dueAt) > tMs) continue;
    bill.paidPaymentId = pay(s, events, at, bill.supplierId, bill.amount, { reason: "payable", payableId: bill.id });
  }
}

function sell(s: ShopState, events: SimEvent[], tMs: number, rng: Prng): void {
  // SKU の順は並べ替えて決める（jsonb でキーの順が変わっても同じ乱数を同じ SKU に使う）
  const sold: Record<string, number> = {};
  for (const sku of Object.keys(s.inventory).sort()) {
    const inv = s.inventory[sku];
    const factor = 0.8 + 0.4 * rng.nextFloat();
    if (!inv) continue;
    const n = Math.round((s.normal[sku]?.dailyDemand ?? 0) * factor);
    // 0未満もそのまま（欠品）。minQuantity を更新（O-05）
    inv.quantity -= n;
    inv.minQuantity = Math.min(inv.minQuantity, inv.quantity);
    sold[sku] = n;
  }
  events.push(numbered(s, { at: formatJst(tMs), kind: "sales", result: { sold }, caller: "clock" }));
}

/** to まで時計を進めた新しい状態と、起きた事象を返す。to が今以前なら何もしない（同じ状態・事象なし） */
export function advanceShop(state: ShopState, to: IsoDateTime): { state: ShopState; events: SimEvent[] } {
  const fromMs = parseIso(state.clock.now);
  const toMs = parseIso(to);
  if (toMs <= fromMs) return { state, events: [] };
  if (toMs - fromMs > MAX_ADVANCE_DAYS * DAY_MS) throw new RangeError(`一度に進められるのは ${MAX_ADVANCE_DAYS} 日まで：${to}`);

  const s = structuredClone(state);
  const rng = createPrng(s.rng);
  const events: SimEvent[] = [];
  for (let day = jstMidnight(fromMs); day <= toMs; day += DAY_MS) {
    const points: Array<[number, (t: number) => void]> = [
      [day + DELIVERY, (t) => deliver(s, events, t)],
      [day + PAYABLES, (t) => payDueBills(s, events, t)],
      [day + SALES, (t) => sell(s, events, t, rng)],
    ];
    for (const [t, run] of points) if (t > fromMs && t <= toMs) run(t);
  }
  const from = s.clock.now;
  s.rng = rng.state();
  s.clock = {
    now: formatJst(toMs),
    tz: "Asia/Tokyo",
    day: s.clock.day + Math.round((jstMidnight(toMs) - jstMidnight(fromMs)) / DAY_MS),
  };
  events.push(numbered(s, { at: s.clock.now, kind: "clock", result: { from, to: s.clock.now, day: s.clock.day }, caller: "clock" }));
  return { state: s, events };
}
