// コネクタの URL の origin
import { describe, expect, it } from "vitest";
import { originOf } from "./origin.ts";

describe("originOf", () => {
  it("読めなければ null", () => {
    expect(originOf("https://gcal.example/mcp/x")).toBe("https://gcal.example");
    expect(originOf("nope")).toBeNull();
  });
});
