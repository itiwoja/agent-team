import { describe, expect, it } from "vitest";
import { parseActionRequest, parseBrowserAction, ValidationError } from "./protocol.ts";

describe("操作の検証", () => {
  it.each([
    { kind: "screenshot" }, { kind: "read_page" }, { kind: "cursor_position" },
    { kind: "left_mouse_down" }, { kind: "left_mouse_up" },
    ...["mouse_move", "left_click", "right_click", "middle_click", "double_click", "triple_click"].map((kind) => ({ kind, x: 0, y: 799 })),
    { kind: "left_click_drag", startX: 1279, startY: 0, x: 0, y: 799 },
    { kind: "type", text: "日本語\n入力" }, { kind: "type", text: "" },
    { kind: "key", text: "ctrl+shift+a" }, { kind: "key", text: "Return" },
    { kind: "hold_key", text: "Shift_L", duration: 0.2 },
    ...["up", "down", "left", "right"].map((direction) => ({ kind: "scroll", direction, amount: 1 })),
    { kind: "scroll", direction: "down", amount: 100, x: 1279, y: 799 },
    { kind: "wait", duration: 0 }, { kind: "wait", duration: 10 },
    { kind: "open_url", url: "https://example.test/path?q=日本語#section" },
    { kind: "open_url", url: "http://shell:8000/" },
  ])("許可した操作を受ける: %j", (action) => {
    expect(parseBrowserAction(action)).toEqual(action);
  });

  it.each([
    null, [], "screenshot", {}, { kind: "zoom" }, { kind: "unknown" },
    { kind: "screenshot", unused: true }, { kind: "screenshot", dryRun: false },
    { kind: "mouse_move", x: 1280, y: 0 }, { kind: "left_click", x: 0, y: 800 },
    { kind: "left_click", x: -1, y: 1 }, { kind: "left_click", x: 0.5, y: 1 },
    { kind: "left_click", x: "0", y: 1 }, { kind: "left_click", x: 0 },
    { kind: "left_click_drag", startX: -1, startY: 0, x: 0, y: 0 },
    { kind: "left_click_drag", x: 0, y: 0 },
    { kind: "scroll", direction: "diagonal", amount: 1 },
    { kind: "scroll", direction: "up", amount: 0 },
    { kind: "scroll", direction: "up", amount: 101 },
    { kind: "scroll", direction: "up", amount: 1.5 },
    { kind: "scroll", direction: "up", amount: 1, x: 1 },
    { kind: "scroll", direction: "up", amount: 1, y: 1 },
    { kind: "scroll", direction: "up", amount: 1, x: undefined, y: undefined },
    { kind: "wait", duration: -0.01 }, { kind: "wait", duration: 10.01 },
    { kind: "wait", duration: NaN }, { kind: "wait", duration: Infinity },
    { kind: "wait", duration: "1" }, { kind: "hold_key", text: "a", duration: 11 },
    ...["", "a\0", "a\n", "a\r", "ctrl++a", "+a", "a+", "--delay", "a b", "a;pwd", "a".repeat(129)].map((text) => ({ kind: "key", text })),
    { kind: "hold_key", text: "a\n", duration: 1 }, { kind: "type", text: 1 },
    ...["javascript:alert(1)", "file:///tmp/a", "chrome://settings", "data:text/html,a", "//example.test", "http:", "http:///", "https://", " https://example.test", "https://example.test/\n"].map((url) => ({ kind: "open_url", url })),
  ])("不正・未対応を拒否する: %j", (action) => {
    expect(() => parseBrowserAction(action)).toThrow(ValidationError);
  });

  it("typeは文字数ではなくUTF-8の16000バイト上限を使う", () => {
    expect(parseBrowserAction({ kind: "type", text: "あ".repeat(5333) + "a" })).toHaveProperty("kind", "type");
    expect(() => parseBrowserAction({ kind: "type", text: "あ".repeat(5334) })).toThrow(ValidationError);
    expect(() => parseBrowserAction({ kind: "type", text: "a".repeat(16001) })).toThrow(ValidationError);
  });

  it("keyは128文字、URLは4096文字まで", () => {
    expect(parseBrowserAction({ kind: "key", text: "a".repeat(128) })).toHaveProperty("kind", "key");
    const url = "https://example.test/".padEnd(4096, "a");
    expect(parseBrowserAction({ kind: "open_url", url })).toEqual({ kind: "open_url", url });
    expect(() => parseBrowserAction({ kind: "open_url", url: `${url}a` })).toThrow(ValidationError);
  });
});

describe("操作要求の検証", () => {
  const valid = { actionId: "action-1", controlEpoch: 0, action: { kind: "screenshot" } };
  it("必要な欄だけを受ける", () => {
    expect(parseActionRequest(valid)).toEqual(valid);
  });
  it.each([
    { dryRun: false }, { dryRun: true }, { expect: null }, { expect: "hash" },
    { expect: undefined }, { extra: 1 }, { actionId: "" }, { actionId: "a\n" },
    { actionId: "a".repeat(129) }, { actionId: 1 }, { controlEpoch: -1 },
    { controlEpoch: 0.1 }, { controlEpoch: "0" }, { controlEpoch: Number.MAX_SAFE_INTEGER + 1 },
  ])("指定された未対応欄・不正値は拒否する: %j", (extra) => {
    expect(() => parseActionRequest({ ...valid, ...extra })).toThrow(ValidationError);
  });
});
