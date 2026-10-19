// ツールの呼び出し（sim-world-rehearsal.md §4.1.2 の手順4〜7。保存・応答の形は apps/sim-world）
// 手順：4 引数を Zod（strict）で検証 → 5 callCount += 1・F-08 → 6 F-07 → F-06 → F-01 → 7 ツールの処理 → 事象を1行
// エージェントのツールでは時計は進まない（§3.5）。引数の状態は変えず、新しい状態を返す

import { DAY_MS, MINUTE_MS, formatJst, jstMidnight, parseIso } from "../../clock.ts";
import { formatZodIssues } from "../../scenario.ts";
import { seqId } from "../../util.ts";
import type { CallCtx, SimEvent, ToolCall, ToolOutcome } from "../../world.ts";
import { isShopToolName, isShopWriteTool, isSimGcalToolName, isSimGcalWriteTool } from "./names.ts";
import { numberedEvent as numbered } from "./events.ts";
import { SIM_GCAL_TOOL_INPUTS, runSimGcalTool } from "./calendar-tools.ts";
import { orderTotalJpy, type ShopOrder, type ShopOrderItem, type ShopState } from "./state.ts";
import {
  SHOP_TOOL_INPUTS,
  type GetInventoryOutput,
  type ListInboxArgs,
  type ListInboxOutput,
  type ListProductsArgs,
  type ListProductsOutput,
  type MailSendArgs,
  type MailSendOutput,
  type PlaceOrderArgs,
  type PlaceOrderOutput,
  type RegisterPayeeArgs,
  type RegisterPayeeOutput,
} from "./tools.ts";

type Outcome = ToolOutcome<ShopState>;

/** F-08：afterCalls 回呼んだあと（callCount ≥ afterCalls）で対象の書き込みツールの説明を替える（FI-20） */
function fireToolDescriptionChange(s: ShopState, ctx: CallCtx, out: SimEvent[]): void {
  for (const f of s.faults) {
    if (f.id !== "F-08" || f.state.fired || s.callCount < f.afterCalls) continue;
    f.state.fired = true;
    f.state.calls = s.callCount;
    s.toolDescriptions[f.tool] = f.newDescription;
    out.push(
      numbered(s, {
        at: s.clock.now,
        kind: "fault",
        tool: f.tool,
        result: { faultId: "F-08", description: f.newDescription },
        intentId: ctx.intentId,
        taskId: ctx.taskId,
        caller: ctx.caller,
      }),
    );
  }
}

/** F-07：対象ツールの先頭 count 回を失敗させる */
function takeTransientError(s: ShopState, tool: string): 429 | 503 | null {
  let hit: 429 | 503 | null = null;
  for (const f of s.faults) {
    if (f.id !== "F-07" || f.tool !== tool) continue;
    const n = f.state.calls;
    f.state.calls += 1;
    if (hit === null && n < f.count) {
      f.state.fired = true;
      hit = f.status;
    }
  }
  return hit;
}

/** F-01：その道具の nthCall 回目の書き込み（仕入れ先・SKU の確認を通ったもの）なら入荷の遅れの日数を返す（発注・予定の登録） */
function takeTimeout(s: ShopState, tool: string): number | null {
  let delay: number | null = null;
  for (const f of s.faults) {
    if (f.id !== "F-01" || f.tool !== tool) continue;
    f.state.calls += 1;
    if (delay === null && f.state.calls === f.nthCall) {
      f.state.fired = true;
      delay = f.deliveryDelayDays;
    }
  }
  return delay;
}

/** 在庫を商品の表の順に（jsonb でキーの順が変わっても同じ順になるように） */
function inventoryOutput(s: ShopState, nowMs: number): GetInventoryOutput {
  let asOfMs = nowMs;
  const stale = new Map<string, number>();
  // F-06：最初の staleCalls 回は古い値（as_of が staleAsOfHours 前）。そのあとは本当の値（U-06「呼ぶたびに合わない」）
  for (const f of s.faults) {
    if (f.id !== "F-06") continue;
    const n = f.state.calls;
    f.state.calls += 1;
    if (n < f.staleCalls && !stale.has(f.sku)) {
      f.state.fired = true;
      stale.set(f.sku, f.staleQuantity);
      asOfMs = Math.min(asOfMs, nowMs - f.staleAsOfHours * 60 * MINUTE_MS);
    }
  }
  const seen = new Set<string>();
  const items: GetInventoryOutput["items"] = [];
  for (const c of s.catalog) {
    const inv = s.inventory[c.sku];
    const normal = s.normal[c.sku];
    if (seen.has(c.sku) || !inv || !normal) continue;
    seen.add(c.sku);
    items.push({ sku: c.sku, name: c.name, unit: normal.unit, quantity: stale.get(c.sku) ?? inv.quantity });
  }
  return { as_of: formatJst(asOfMs), items };
}

export function handleShopTool(state: ShopState, call: ToolCall, ctx: CallCtx): ToolOutcome<ShopState> {
  const s = structuredClone(state);
  const name = `${call.connector}.${call.tool}`;
  const args: unknown = call.args === undefined ? {} : structuredClone(call.args);
  const write = isShopWriteTool(name) || isSimGcalWriteTool(name);
  const pre: SimEvent[] = [];

  const record = (outcome: NonNullable<SimEvent["outcome"]>, result: unknown, committed: boolean) => {
    const event = numbered(s, {
      at: s.clock.now,
      kind: "tool_call",
      tool: name,
      args,
      result,
      outcome,
      ...(write ? { committed } : {}),
      intentId: ctx.intentId,
      taskId: ctx.taskId,
      caller: ctx.caller,
    });
    return { event, events: [...pre, event] };
  };
  const ok = (result: unknown): Outcome => ({ kind: "ok", state: s, result, ...record("ok", result, true) });
  const toolError = (message: string, outcome: "tool_error" | "http_429" = "tool_error"): Outcome => ({
    kind: "tool_error",
    state: s,
    message,
    ...record(outcome, { isError: true, message }, false),
  });

  // 4 引数の検証（外れたら状態は変えない。事象だけ残す）
  if (!isShopToolName(name) && !isSimGcalToolName(name)) return toolError(`ツールがありません：${name}`);
  const parsed = (isSimGcalToolName(name) ? SIM_GCAL_TOOL_INPUTS[name] : SHOP_TOOL_INPUTS[name]).safeParse(args);
  if (!parsed.success) return toolError(`引数が正しくありません：${formatZodIssues(parsed.error, 10).join(" / ")}`);

  // 5 通しの回数と F-08
  s.callCount += 1;
  fireToolDescriptionChange(s, ctx, pre);

  // 6 F-07（429 は isError、503 は HTTP 503。書き込みは反映しない）
  const transient = takeTransientError(s, name);
  if (transient === 429) return toolError("429 Too Many Requests", "http_429");
  if (transient === 503) {
    return { kind: "http_error", state: s, status: 503, ...record("http_503", { status: 503 }, false) };
  }

  // 7 ツールの処理
  const now = s.clock.now;
  const nowMs = parseIso(now);
  if (isSimGcalToolName(name)) {
    // 模擬のカレンダー（16 §6.2）。F-01 は予定の登録のあとでも 504（反映済み）
    const g = runSimGcalTool(s, name, parsed.data, ctx, pre);
    if (g.kind === "tool_error") return toolError(g.message);
    if (name === "gcal.create_event" && takeTimeout(s, name) !== null) {
      return { kind: "http_error", state: s, status: 504, ...record("timeout_after_commit", g.result, true) };
    }
    return ok(g.result);
  }
  if (!isShopToolName(name)) return toolError(`ツールがありません：${name}`);
  switch (name) {
    case "store.get_inventory":
      return ok(inventoryOutput(s, nowMs));

    case "supplier.list_products": {
      const a = parsed.data as ListProductsArgs;
      if (a.supplier_id !== undefined && !s.suppliers.some((x) => x.id === a.supplier_id)) {
        return toolError(`仕入れ先がありません：${a.supplier_id}`);
      }
      const out: ListProductsOutput = {
        products: s.catalog
          .filter((c) => a.supplier_id === undefined || c.supplierId === a.supplier_id)
          .map((c) => ({
            supplier_id: c.supplierId,
            supplier_name: s.suppliers.find((x) => x.id === c.supplierId)?.name ?? c.supplierId,
            sku: c.sku,
            name: c.name,
            unit: c.unit,
            pack_size: c.packSize,
            unit_price: c.unitPrice,
            currency: "JPY",
            price_updated_at: c.priceUpdatedAt,
          })),
      };
      return ok(out);
    }

    case "supplier.place_order": {
      const a = parsed.data as PlaceOrderArgs;
      const supplier = s.suppliers.find((x) => x.id === a.supplier_id);
      if (!supplier) return toolError(`仕入れ先がありません：${a.supplier_id}`);
      const lines: ShopOrderItem[] = [];
      for (const it of a.items) {
        const c = s.catalog.find((x) => x.supplierId === supplier.id && x.sku === it.sku);
        if (!c) return toolError(`${supplier.name}（${supplier.id}）の商品にない SKU です：${it.sku}`);
        // 単価は引数の値で記録する（＝その値で買った）
        lines.push({ sku: it.sku, quantity: it.quantity, unitPrice: it.unit_price, packSize: c.packSize });
      }
      // F-01：注文は状態に反映し、入荷を遅らせ、504 を返す（60秒待たない：M-52）
      const delayDays = takeTimeout(s, name);
      const order: ShopOrder = {
        id: seqId("order", s.orders.length + 1),
        supplierId: supplier.id,
        items: lines,
        ...(a.note !== undefined ? { note: a.note } : {}),
        placedAt: now,
        deliverAt: formatJst(jstMidnight(nowMs) + (delayDays ?? 1) * DAY_MS + 7 * 60 * MINUTE_MS),
        status: "accepted",
        intentId: ctx.intentId,
        taskId: ctx.taskId,
      };
      s.orders.push(order);
      const out: PlaceOrderOutput = {
        order_id: order.id,
        accepted_at: order.placedAt,
        total_jpy: orderTotalJpy(lines),
        expected_delivery_at: order.deliverAt,
      };
      if (delayDays !== null) {
        return { kind: "http_error", state: s, status: 504, ...record("timeout_after_commit", out, true) };
      }
      return ok(out);
    }

    case "mail.list_inbox": {
      const a = parsed.data as ListInboxArgs;
      // only_new なら isNew のものを新しい順に limit 件。読んでも isNew は変えない
      const out: ListInboxOutput = {
        messages: s.inbox
          .map((m, i) => ({ m, i }))
          .filter(({ m }) => !a.only_new || m.isNew)
          .sort((x, y) =>
            x.m.receivedAt > y.m.receivedAt ? -1 : x.m.receivedAt < y.m.receivedAt ? 1 : y.i - x.i,
          )
          .slice(0, a.limit)
          .map(({ m }) => ({
            id: m.id,
            from_name: m.fromName,
            from_address: m.fromAddress,
            subject: m.subject,
            body: m.body,
            received_at: m.receivedAt,
            is_new: m.isNew,
          })),
      };
      return ok(out);
    }

    case "mail.send": {
      const a = parsed.data as MailSendArgs;
      const sent = { id: seqId("sent", s.sentMails.length + 1), to: a.to, body: a.body, sentAt: now, intentId: ctx.intentId };
      s.sentMails.push(sent);
      const out: MailSendOutput = { message_id: sent.id, sent_at: sent.sentAt };
      return ok(out);
    }

    case "bank.register_payee": {
      const a = parsed.data as RegisterPayeeArgs;
      const supplier = s.suppliers.find((x) => x.id === a.supplier_id);
      if (!supplier) return toolError(`仕入れ先がありません：${a.supplier_id}`);
      // その仕入れ先の有効な振込先を新しい口座に替える（前のものは active = false）
      for (const p of s.payees) if (p.supplierId === supplier.id) p.active = false;
      const payee = {
        id: seqId("payee", s.payees.length + 1),
        supplierId: supplier.id,
        account: a.account,
        registeredAt: now,
        active: true,
        viaIntentId: ctx.intentId,
      };
      s.payees.push(payee);
      const out: RegisterPayeeOutput = {
        payee_id: payee.id,
        supplier_id: supplier.id,
        account: payee.account,
        effective_at: now,
      };
      return ok(out);
    }
  }
}
