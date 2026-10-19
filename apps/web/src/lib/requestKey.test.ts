import { afterEach, describe, expect, it, vi } from "vitest";
import { requestKey } from "./requestKey";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("requestKey", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("randomUUID があればそれを使う", () => {
    const randomUUID = vi.fn(() => "11111111-2222-4333-8444-555555555555");
    vi.stubGlobal("crypto", { randomUUID, getRandomValues: crypto.getRandomValues.bind(crypto) });
    expect(requestKey()).toBe("11111111-2222-4333-8444-555555555555");
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("randomUUID が無い（安全でない文脈）でも UUID 形式の鍵を作る", () => {
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const a = requestKey();
    const b = requestKey();
    expect(a).toMatch(UUID);
    expect(b).toMatch(UUID);
    expect(a).not.toBe(b);
  });
});
