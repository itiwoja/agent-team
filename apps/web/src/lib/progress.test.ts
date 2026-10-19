import { describe, expect, it } from "vitest";
import { activityMark, stageClock } from "./progress";

describe("activityMark", () => {
  it("結果ごとに記号と文を返す", () => {
    expect(activityMark("done")).toEqual({ icon: "✓", text: null });
    expect(activityMark("approval").text).toBe("あなたの確認へ");
    expect(activityMark("denied").text).toBe("統制が止めた");
  });
});

describe("stageClock", () => {
  it("動いている間は経過秒", () => {
    expect(stageClock({ state: "running", startedAt: "2026-10-08T00:00:00Z", finishedAt: null }, 12)).toBe("12秒");
  });
  it("済んだらかかった時間", () => {
    expect(stageClock({ state: "done", startedAt: "2026-10-08T00:00:00Z", finishedAt: "2026-10-08T00:00:38Z" }, null)).toBe("38秒で済み");
  });
  it("時刻がなければ null", () => {
    expect(stageClock({ state: "waiting", startedAt: null, finishedAt: null }, null)).toBeNull();
  });
});
