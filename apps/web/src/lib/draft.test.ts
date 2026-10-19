import { describe, expect, it } from "vitest";
import { readDraft, writeDraft } from "./draft";

function fakeStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    size: () => m.size,
  };
}

describe("書きかけの文", () => {
  it("書いた文を読み戻せ、空白だけなら消す", () => {
    const s = fakeStorage();
    writeDraft("在庫を見て", s);
    expect(readDraft(s)).toBe("在庫を見て");
    writeDraft("  ", s);
    expect(s.size()).toBe(0);
  });
  it("保存できない環境では、メモリに残した文を返す", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    writeDraft("発注して", broken);
    expect(readDraft(broken)).toBe("発注して");
    expect(readDraft(null)).toBe("発注して");
  });
});
