// 結果の文字・マスク・64KB（A-86、MT §3.10 の3、IA G-14）
import { describe, expect, it } from "vitest";
import { OMITTED_AUDIO, OMITTED_IMAGE, RESULT_MAX_BYTES, maskAndLimit, toolResultText, truncateUtf8 } from "./result-text.ts";

describe("toolResultText（MT §3.10 の3）", () => {
  it("text はそのまま、image・audio は省略の印、resource は文字のものだけ、resource_link は入れない。改行でつなぐ", () => {
    const text = toolResultText({
      content: [
        { type: "text", text: "一行目" },
        { type: "image", data: "aGk=", mimeType: "image/png" },
        { type: "audio", data: "aGk=", mimeType: "audio/wav" },
        { type: "resource", resource: { uri: "file:///a.txt", text: "資料の本文" } },
        { type: "resource", resource: { uri: "file:///b.bin", blob: "AAAA" } },
        { type: "resource_link", uri: "https://example.com/x", name: "x" },
      ],
    });
    expect(text).toBe(["一行目", OMITTED_IMAGE, OMITTED_AUDIO, "資料の本文"].join("\n"));
  });
  it("文字の部分がなく structuredContent があれば正規形 JSON（text と二重にしない）", () => {
    expect(toolResultText({ content: [], structuredContent: { b: 2, a: [1, "x"] } })).toBe('{"a":[1,"x"],"b":2}');
    expect(toolResultText({ content: [{ type: "text", text: '{"a":1}' }], structuredContent: { a: 1 } })).toBe('{"a":1}');
  });
  it("content がなければ空", () => {
    expect(toolResultText({ content: [] })).toBe("");
  });
});

describe("truncateUtf8", () => {
  it("上限以内ならそのまま", () => {
    expect(truncateUtf8("あいう", 9)).toEqual({ text: "あいう", truncated: false });
  });
  it("多バイト文字の途中で切らない（境界：8バイトで「あい」まで）", () => {
    expect(truncateUtf8("あいう", 8)).toEqual({ text: "あい", truncated: true });
    expect(truncateUtf8("あいう", 6)).toEqual({ text: "あい", truncated: true });
    expect(truncateUtf8("aあ", 3)).toEqual({ text: "a", truncated: true });
  });
  it("サロゲートペア（4バイト）も途中で切らない", () => {
    expect(truncateUtf8("😀😀", 7)).toEqual({ text: "😀", truncated: true });
  });
});

describe("maskAndLimit（G-14：100KB・秘密情報のパターン）", () => {
  it("100KB の応答を 64KB に切り、秘密情報をマスクする（先にマスクするので切り口に秘密の一部が残らない）", () => {
    const secret = `ghp_${"A".repeat(36)}`;
    const big = `${secret} ${"x".repeat(100 * 1024)}`;
    const r = maskAndLimit(big, []);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(RESULT_MAX_BYTES);
    expect(r.text).not.toContain(secret);
    expect(r.text.startsWith("[REDACTED]")).toBe(true);
  });
  it("既知の秘密（共有トークンなど）もマスクする。カナリア（OT-CANARY-…）は残す（漏えいの試験のため）", () => {
    const known = "known-secret-value-0123456789abcdef";
    const r = maskAndLimit(`token=${known} canary=OT-CANARY-0123456789ab`, [known]);
    expect(r.text).toBe("token=[REDACTED] canary=OT-CANARY-0123456789ab");
    expect(r.truncated).toBe(false);
  });
  it("境界：ちょうど 64KB は切らない、1バイト超えたら切る", () => {
    expect(maskAndLimit("a".repeat(RESULT_MAX_BYTES), []).truncated).toBe(false);
    expect(maskAndLimit("a".repeat(RESULT_MAX_BYTES + 1), []).truncated).toBe(true);
  });
});
