// 入口の試行の試験（SO §7.3 の SO-ENT-07・08、§7.4 の SO-GC-07、M-55 の IP の HMAC）
import { describe, expect, it } from "vitest";
import { useTestDb } from "../testing.ts";
import { countEntryAttempts, ENTRY_LIMITS, hashIp, normalizeIp, recordEntryAttempt, recordWrongToken, wrongTokenDelayMs } from "./entry.ts";

const T = useTestDb();
const NOW = new Date("2026-10-12T09:00:00.000Z");
const SECRET = "test-secret-0123456789";

describe("同じ IP の見分け方（SO §3.5【提案】）", () => {
  it("IPv4 はそのまま、IPv6 は先頭 /64（SO-GC-07）", () => {
    expect(normalizeIp("203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeIp("2001:db8:1:1::1")).toBe("2001:db8:1:1::/64");
    expect(normalizeIp("2001:db8:1:1::2")).toBe("2001:db8:1:1::/64");
    expect(normalizeIp("2001:0DB8:0001:0001:ffff:0:0:9")).toBe("2001:db8:1:1::/64");
    expect(normalizeIp("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(normalizeIp("::1")).toBe("0:0:0:0::/64");
    expect(normalizeIp("[2001:db8:1:1::5]")).toBe("2001:db8:1:1::/64");
    expect(normalizeIp("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  it("IPv4 に写した IPv6（::ffff:a.b.c.d）は IPv4 として数える", () => {
    expect(normalizeIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeIp("::ffff:cb00:7107")).toBe("203.0.113.7");
  });

  it("IP として読めない値は小文字にしただけ", () => {
    expect(normalizeIp(" Unknown ")).toBe("unknown");
  });

  it("HMAC は小文字16進64桁。同じ /64 は同じ値、鍵が違えば別の値、短い鍵は断る", () => {
    const a = hashIp("2001:db8:1:1::1", SECRET);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashIp("2001:db8:1:1::2", SECRET)).toBe(a);
    expect(hashIp("2001:db8:1:2::1", SECRET)).not.toBe(a);
    expect(hashIp("2001:db8:1:1::1", `${SECRET}x`)).not.toBe(a);
    expect(hashIp("203.0.113.7", SECRET)).not.toContain("203");
    expect(() => hashIp("203.0.113.7", "short")).toThrow(RangeError);
  });
});

describe("失敗が続く IP の待ち時間（SO-ENT-07・08、SO I-13）", () => {
  it("直近10分の失敗が4件までは待たない。5件目から 1・2・4・8・10秒（上限）", () => {
    expect([1, 2, 3, 4].map(wrongTokenDelayMs)).toEqual([0, 0, 0, 0]);
    expect([5, 6, 7, 8, 9, 10, 50].map(wrongTokenDelayMs)).toEqual([1000, 2000, 4000, 8000, 10_000, 10_000, 10_000]);
  });

  it("最初の失敗からちょうど10分後は、その失敗を数えない（>）", async () => {
    const { db } = T();
    const ip = hashIp("203.0.113.7", SECRET);
    await recordEntryAttempt(db, { ipHash: ip, outcome: "wrong_token", now: new Date(NOW.getTime() - ENTRY_LIMITS.wrongTokenWindowMs) });
    for (let i = 3; i >= 1; i--) await recordEntryAttempt(db, { ipHash: ip, outcome: "wrong_token", now: new Date(NOW.getTime() - i * 1000) });
    // 今回で窓の中は4件（ちょうど10分前の1件は数えない）→ 待たない
    expect(await recordWrongToken(db, { ipHash: ip, now: NOW })).toEqual({ failures: 4, delayMs: 0 });
    expect(await recordWrongToken(db, { ipHash: ip, now: NOW })).toEqual({ failures: 5, delayMs: 1000 });
    expect(await recordWrongToken(db, { ipHash: ip, now: NOW })).toEqual({ failures: 6, delayMs: 2000 });
    // ほかの IP・ほかの結果は数えない
    const other = hashIp("198.51.100.1", SECRET);
    expect(await recordWrongToken(db, { ipHash: other, now: NOW })).toEqual({ failures: 1, delayMs: 0 });
    await recordEntryAttempt(db, { ipHash: ip, outcome: "guest_created", now: NOW });
    expect(await countEntryAttempts(db, { ipHash: ip, outcomes: ["wrong_token"], since: new Date(NOW.getTime() - ENTRY_LIMITS.wrongTokenWindowMs) })).toBe(6);
    expect(await countEntryAttempts(db, { ipHash: ip, outcomes: ["wrong_token", "guest_created"], since: new Date(0) })).toBe(8);
  });
});
