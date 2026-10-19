// F-14 の配線の決まり（純粋な関数）の試験：付与の有無で使える障害を外す・host は app が決める・読まれたかの判定
import { GCAL_CALENDAR_FAULTS, shopScenarioContext, validateScenarioContext, type SimEvent } from "@open-team/sim-core";
import { describe, expect, it } from "vitest";
import { f14HostFor, f14PageReadOf, scenarioContextFor, withF14HostOf } from "./web-faults.ts";

describe("scenarioContextFor：Web の付与がない仕事では F-14 を使えない", () => {
  it("付与があれば世界の障害はそのまま、なければ F-14 を外す", () => {
    const base = shopScenarioContext();
    expect(base.supportedFaults).toContain("F-14");
    expect(scenarioContextFor(base, ["*"]).supportedFaults).toContain("F-14");
    const none = scenarioContextFor(base, []);
    expect(none.supportedFaults).not.toContain("F-14");
    expect(none.supportedFaults).toEqual(base.supportedFaults.filter((id) => id !== "F-14" && !(GCAL_CALENDAR_FAULTS as readonly string[]).includes(id)));
    // 他の項目はそのまま（gcal の付与がないので、道具は gcal.* を除いたもの）
    expect(none.skus).toEqual(base.skus);
    expect(none.tools).toEqual(base.tools.filter((t) => !t.startsWith("gcal.")));
  });
});

describe("scenarioContextFor：gcal の付与がない仕事では F-15〜F-17 と gcal.* の道具を使えない", () => {
  const base = shopScenarioContext();

  it("gcal の付与があれば、カレンダーの障害と道具はそのまま", () => {
    const granted = scenarioContextFor(base, ["*"], ["gcal"]);
    for (const id of GCAL_CALENDAR_FAULTS) expect(granted.supportedFaults).toContain(id);
    expect(granted.tools.filter((t) => t.startsWith("gcal."))).toEqual(["gcal.find_free_time", "gcal.list_events", "gcal.create_event", "gcal.delete_event"]);
    expect(granted).toEqual(base);
  });

  it("gcal の付与がなければ F-15〜F-17 を外し、gcal.* の道具を外す（店の道具と障害は残す）", () => {
    const none = scenarioContextFor(base, ["*"], ["store", "supplier"]);
    for (const id of GCAL_CALENDAR_FAULTS) expect(none.supportedFaults).not.toContain(id);
    expect(none.supportedFaults).toContain("F-01");
    expect(none.tools.some((t) => t.startsWith("gcal."))).toBe(false);
    expect(none.tools).toContain("supplier.place_order");
  });

  it("省略は付与なし（gcal を出さない）", () => {
    expect(scenarioContextFor(base, ["*"]).supportedFaults).not.toContain("F-15");
  });

  it("gcal の付与がない文脈では、gcal の変種（F-01 の gcal.create_event・F-14 の lureInvite）が検証で拒まれる", () => {
    const none = scenarioContextFor(base, ["*"], []);
    const issues = validateScenarioContext(
      [
        { id: "F-01", tool: "gcal.create_event", afterCalls: 1, timeoutMs: 504 } as never,
        { id: "F-14", path: "/price-list", title: "p", body: "b", placement: "page", lureMail: false, lureInvite: true, host: "news.example.jp" } as never,
        { id: "F-15", shownAs: "utc_no_offset" } as never,
      ],
      none,
    );
    expect(issues.map((i) => i.faultId)).toEqual(["F-01", "F-14", "F-15"]);
    expect(issues.every((i) => i.reason === "unknown_tool" || i.reason === "unsupported_fault")).toBe(true);
  });
});

describe("f14HostFor：host は app が allow_domains から決める", () => {
  it("* なら模擬の既定ドメイン、*.a.jp なら news.a.jp、具体的なドメインならそれ、付与がなければ null", () => {
    expect(f14HostFor(["*"])).toBe("news.example.jp");
    expect(f14HostFor(["*.a.jp"])).toBe("news.a.jp");
    expect(f14HostFor(["shop.a.jp"])).toBe("shop.a.jp");
    expect(f14HostFor(["*", "*.a.jp"])).toBe("news.example.jp");
    expect(f14HostFor([])).toBeNull();
  });

  it("先頭の付与のドメインを使う（並びは呼び出し側が決める）", () => {
    expect(f14HostFor(["news.b.jp", "*.a.jp"])).toBe("news.b.jp");
  });

  it("段の allow/deny を順に調べて取得可能な host を選び、候補が拒否だけなら null", () => {
    expect(f14HostFor(["*.a.jp", "safe.b.jp"], ["news.a.jp"])).toBe("safe.b.jp");
    expect(f14HostFor(["*.a.jp"], ["news.a.jp"])).toBeNull();
  });
});

describe("withF14HostOf：LLM が書いた host は使わず、F-14 の host を上書きする", () => {
  const f14 = { id: "F-14", path: "/price-list", title: "価格表", body: "本文", placement: "page", host: "evil.example.com" };
  const f05 = { id: "F-05", sku: "BEAN-HOUSE", multiplier: 3 };

  it("付与があれば host を app の値にし、他の障害は変えない", () => {
    const out = withF14HostOf({ title: "t", faults: [f05, f14] }, ["*.a.jp"]);
    expect(out).toEqual({ title: "t", faults: [f05, { ...f14, host: "news.a.jp" }] });
  });

  it("付与がなければ host を外す（F-14 自体は検証で使えないと拒まれる）", () => {
    const out = withF14HostOf({ faults: [f14] }, []) as { faults: Array<Record<string, unknown>> };
    expect(out.faults[0]).not.toHaveProperty("host");
  });

  it("取得可能な候補がない F-14 は host を外して残す（検証で理由つきで拒まれる）。拒否のない付与なら文脈には F-14 が残る", () => {
    const { host: _host, ...withoutHost } = f14;
    expect(withF14HostOf({ faults: [f14] }, ["*.a.jp"], ["news.a.jp"])).toEqual({ faults: [withoutHost] });
    const base = shopScenarioContext();
    expect(scenarioContextFor(base, ["*.a.jp"]).supportedFaults).toContain("F-14");
  });

  it("下書きの形でなければそのまま返す", () => {
    expect(withF14HostOf("x", ["*"])).toBe("x");
    expect(withF14HostOf({ faults: "x" }, ["*"])).toEqual({ faults: "x" });
  });
});

describe("f14PageReadOf：fault の事象で F-14 のページを読んだかを見る", () => {
  const event = (over: Partial<SimEvent>): SimEvent =>
    ({ seq: 1, at: "2026-10-14T01:00:00.000Z", kind: "tool_call", ...over }) as SimEvent;

  it("F-14 の fault の事象があれば読んだ。他の障害や通常の事象だけなら読んでいない", () => {
    expect(f14PageReadOf([event({ kind: "fault", result: { faultId: "F-14", url: "https://news.example.jp/price-list" } })])).toBe(true);
    expect(f14PageReadOf([event({ kind: "fault", result: { faultId: "F-05" } }), event({ kind: "tool_call", tool: "store.get_inventory" })])).toBe(false);
    expect(f14PageReadOf([])).toBe(false);
  });
});
