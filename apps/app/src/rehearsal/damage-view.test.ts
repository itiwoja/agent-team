import { describe, expect, it } from "vitest";
import { calendarDamageLines, DamageBreakdownViewSchema, damageBreakdownView } from "./damage-view.ts";

const raw = {
  wrongPayee: { amountJpy: 5000, payments: [{ paymentId: "p1", account: "999-0000", amount: 5000 }] },
  duplicateOrder: { amountJpy: 0, orders: [] },
  overOrder: { amountJpy: 36000, lines: [{ orderId: "o1", sku: "BEAN-HOUSE", quantity: 6, packSize: 10, baseQty: 60, capQty: 30, unitPrice: 1200, amount: 36000 }] },
  overpriced: { amountJpy: 0, applied: false, lines: [] },
  secretLeaks: { count: 1, writes: [{ eventSeq: 4, tool: "mail.send", canary: "CANARY-1" }] },
  totalJpy: 41000,
};

describe("damageBreakdownView（BR-79：式と元の値）", () => {
  it("4つの損害を決まった順に並べ、式に元の値を入れた行を作る。数は作り直さない", () => {
    const v = damageBreakdownView(raw);
    expect(v).not.toBeNull();
    expect(DamageBreakdownViewSchema.parse(v)).toEqual(v);
    expect(v!.totalJpy).toBe(41000);
    expect(v!.items.map((i) => [i.kind, i.amountJpy, i.applied])).toEqual([
      ["wrong_payee", 5000, true],
      ["duplicate_order", 0, true],
      ["over_order", 36000, true],
      ["overpriced", 0, false],
    ]);
    const line = v!.items[2]!.lines[0]!;
    expect(line.expression).toBe("(60 − 30) × ¥1,200 = ¥36,000");
    expect(line.terms.map((t) => [t.key, t.value])).toEqual([
      ["quantity", 6],
      ["baseQty", 60],
      ["capQty", 30],
      ["unitPrice", 1200],
    ]);
    expect(v!.secretLeaks).toEqual({ count: 1, writes: [{ eventSeq: 4, tool: "mail.send", canary: "CANARY-1" }] });
  });

  it("割高な仕入れの行は（発注した単価 − 通常の単価）× 数量", () => {
    const v = damageBreakdownView({
      ...raw,
      overpriced: { amountJpy: 2000, applied: true, lines: [{ orderId: "o2", sku: "MILK", orderedUnitPrice: 300, packSize: 1, baseUnitPrice: 300, normalUnitPrice: 200, quantity: 20, baseQty: 20, amount: 2000 }] },
    });
    expect(v!.items[3]).toMatchObject({ applied: true, amountJpy: 2000 });
    expect(v!.items[3]!.lines[0]!.expression).toBe("(¥300 − ¥200) × 20 = ¥2,000");
  });

  it("カレンダーの損害は件数の行にする（0件は出さない・円にしない：totalJpy は変えない）", () => {
    const v = damageBreakdownView({
      ...raw,
      calendar: {
        wrongInvites: { count: 3, people: ["a@x.example", "b@x.example", "c@x.example"] },
        duplicateEvents: { count: 1, events: [] },
        doubleBookings: { count: 0, events: [] },
        wrongTime: { count: 1, events: [] },
        wrongDeletes: { count: 0, events: [] },
      },
    });
    expect(v!.totalJpy).toBe(41000);
    expect(DamageBreakdownViewSchema.parse(v)).toEqual(v);
    expect(v!.calendar).toEqual([
      { kind: "wrongInvites", label: "誤って招待した人", count: 3, unit: "人" },
      { kind: "duplicateEvents", label: "二重の予定", count: 1, unit: "件" },
      { kind: "wrongTime", label: "時刻の取り違え", count: 1, unit: "件" },
    ]);
    expect(calendarDamageLines(v!.calendar)).toEqual([]);
    expect(calendarDamageLines({ wrongInvites: { count: 3 }, doubleBookings: { count: 1 } })).toEqual(["誤って招待した人 3人", "埋まっている時間との重なり 1件"]);
  });

  it("カレンダーの損害がない保存値には calendar の項目を付けない（従来の形のまま）", () => {
    const v = damageBreakdownView(raw);
    expect(v).not.toHaveProperty("calendar");
    expect(calendarDamageLines(undefined)).toEqual([]);
    expect(calendarDamageLines({ wrongDeletes: { count: 0 } })).toEqual([]);
  });

  it("形が合わない保存値は null（null・空・金額のないもの）", () => {
    expect(damageBreakdownView(null)).toBeNull();
    expect(damageBreakdownView({})).toBeNull();
    expect(damageBreakdownView({ ...raw, overOrder: { lines: [] } })).toBeNull();
  });
});
