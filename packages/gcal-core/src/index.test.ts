import { effectiveArgRoles, validateArgRoleKeys } from "@open-team/kernel";
import { describe, expect, it } from "vitest";
import { GCAL_CONNECTOR, GCAL_TOOL_INPUT_SCHEMAS, eventIdOf, type GcalToolName } from "./index.ts";

describe("gcal-core", () => {
  it("書き込みツールの引数の役割は入力スキーマと合い、全引数に付いている", () => {
    for (const t of GCAL_CONNECTOR.tools) {
      const schema = GCAL_TOOL_INPUT_SCHEMAS[t.name as GcalToolName];
      expect(validateArgRoleKeys(schema, t.argRoles), t.name).toEqual({ ok: true });
      if (t.classification !== "write") continue;
      expect(effectiveArgRoles(schema, t.argRoles), t.name).toEqual(t.argRoles);
      expect(Object.keys(schema.properties as object).filter((p) => !(p in t.argRoles))).toEqual([]);
    }
  });
  it("イベント ID は Intent から決まり、base32hex の文字だけ", () => {
    const id = eventIdOf("0F8B1C2D-3E4F-4a5b-8c6d-7e8f9a0b1c2d");
    expect(id).toBe("mk0f8b1c2d3e4f4a5b8c6d7e8f9a0b1c2d");
    expect(id).toMatch(/^[a-v0-9]{5,1024}$/);
    expect(() => eventIdOf("not-a-uuid")).toThrow();
  });
});
