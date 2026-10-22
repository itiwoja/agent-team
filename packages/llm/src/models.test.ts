import type { LlmPhase } from "@open-team/runner";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_MODEL,
  DEFAULT_PLANNER_MODEL,
  missingGeminiEnv,
  MODEL_ROLE_BY_PURPOSE,
  modelForPhase,
  modelForPurpose,
  modelForRole,
  readGeminiEnv,
} from "./models.ts";
import { findPrice } from "./pricing.ts";

describe("readGeminiEnv（SO §2.2）", () => {
  it("既定：エージェントは gemini-3.8-flash、上位も gemini-3.8-flash、API キーはなし", () => {
    expect(readGeminiEnv({})).toEqual({
      apiKey: undefined,
      agentModel: "gemini-3.8-flash",
      plannerModel: "gemini-3.8-flash",
      compareModels: [],
    });
    expect([DEFAULT_AGENT_MODEL, DEFAULT_PLANNER_MODEL]).toEqual(["gemini-3.8-flash", "gemini-3.8-flash"]);
  });

  it("環境変数で上書きする（前後の空白は除く）", () => {
    expect(
      readGeminiEnv({
        GEMINI_API_KEY: " key-1 ",
        GEMINI_MODEL_AGENT: "gemini-3-flash-preview",
        GEMINI_MODEL_PLANNER: "gemini-3.1-pro-preview",
      }),
    ).toMatchObject({
      apiKey: "key-1",
      agentModel: "gemini-3-flash-preview",
      plannerModel: "gemini-3.1-pro-preview",
    });
  });

  it("空・空白だけの値は「ない」とみなして既定を使う", () => {
    expect(
      readGeminiEnv({ GEMINI_API_KEY: "  ", GEMINI_MODEL_AGENT: "", GEMINI_MODEL_PLANNER: " " }),
    ).toEqual(readGeminiEnv({}));
  });

  it("GEMINI_MODELS_COMPARE はカンマ区切り（空・重なりを除き、順番は保つ）", () => {
    expect(readGeminiEnv({ GEMINI_MODELS_COMPARE: " gemini-3.8-flash, gemini-3.1-pro-preview,,gemini-3.8-flash , gemma-x " }).compareModels).toEqual([
      "gemini-3.8-flash",
      "gemini-3.1-pro-preview",
      "gemma-x",
    ]);
  });

  it("既定のモデルは価格表にある（要確認の単価で数える）", () => {
    const env = readGeminiEnv({});
    expect(findPrice(env.agentModel)).not.toBeNull();
    expect(findPrice(env.plannerModel)).not.toBeNull();
  });
});

describe("missingGeminiEnv（D-47）", () => {
  it("GEMINI_API_KEY がなければその名前を返す（値は返さない）", () => {
    expect(missingGeminiEnv({})).toEqual(["GEMINI_API_KEY"]);
    expect(missingGeminiEnv({ GEMINI_API_KEY: "  " })).toEqual(["GEMINI_API_KEY"]);
  });

  it("そろっていれば空", () => {
    expect(missingGeminiEnv({ GEMINI_API_KEY: "k" })).toEqual([]);
  });
});

describe("モデルの選び方（15_hackathon.md:587）", () => {
  const env = { agentModel: "flash-x", plannerModel: "pro-y" };

  it("LLM Proxy の phase はどれも Flash 系（エージェントの推論。formation-runtime.md §8-7）", () => {
    const phases: LlmPhase[] = ["investigate", "plan", "implement", "review", "report"];
    for (const phase of phases) expect(modelForPhase(env, phase)).toBe("flash-x");
  });

  it("設定プランナーは上位、エージェント・要約は Flash 系", () => {
    expect(modelForPurpose(env, "planner")).toBe("pro-y");
    expect(modelForPurpose(env, "agent")).toBe("flash-x");
    expect(modelForPurpose(env, "summary")).toBe("flash-x");
    expect(Object.keys(MODEL_ROLE_BY_PURPOSE).sort()).toEqual(
      ["agent", "planner", "summary"].sort(),
    );
  });

  it("modelForRole は役割のモデルを返す", () => {
    expect(modelForRole(env, "agent")).toBe("flash-x");
    expect(modelForRole(env, "planner")).toBe("pro-y");
  });
});
