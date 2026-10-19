import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openSecret, sealSecret } from "./secret-box.ts";

const key = randomBytes(32).toString("base64");

describe("secret-box", () => {
  it("同じ鍵・同じ AAD で開ける", () => {
    const s = sealSecret(key, "1//refresh-token", "ws:conn");
    expect(s.startsWith("v1.")).toBe(true);
    expect(openSecret(key, s, "ws:conn")).toBe("1//refresh-token");
  });
  it("AAD が違えば開けない（別のワークスペースの行に写した暗号文）", () => {
    const s = sealSecret(key, "x", "ws-a:conn");
    expect(() => openSecret(key, s, "ws-b:conn")).toThrow();
  });
  it("鍵が違えば開けない", () => {
    const s = sealSecret(key, "x", "a");
    expect(() => openSecret(randomBytes(32).toString("base64"), s, "a")).toThrow();
  });
  it("32バイトでない鍵・壊れた形は例外", () => {
    expect(() => sealSecret(randomBytes(16).toString("base64"), "x", "a")).toThrow();
    expect(() => openSecret(key, "v2.a.b", "a")).toThrow();
  });
});
