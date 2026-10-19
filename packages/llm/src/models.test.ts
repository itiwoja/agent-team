import type { LlmPhase } from "@open-team/runner";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_MODEL,
  DEFAULT_GEMINI_LOCATION,
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
  it("既定：エージェントは gemini-3.8-flash、上位も gemini-3.8-flash、場所は global、プロジェクトはなし", () => {
    expect(readGeminiEnv({})).toEqual({
      project: undefined,
      location: "global",
      agentModel: "gemini-3.8-flash",
      plannerModel: "gemini-3.8-flash",
      compareModels: [],
    });
    expect([DEFAULT_AGENT_MODEL, DEFAULT_PLANNER_MODEL, DEFAULT_GEMINI_LOCATION]).toEqual(["gemini-3.8-flash", "gemini-3.8-flash", "global"]);
  });

  it("環境変数で上書きする（前後の空白は除く）", () => {
    expect(
      readGeminiEnv({
        GOOGLE_CLOUD_PROJECT: " open-team-hack ",
        GOOGLE_CLOUD_LOCATION: "asia-northeast1",
        GEMINI_MODEL_AGENT: "gemini-3-flash-preview",
        GEMINI_MODEL_PLANNER: "gemini-3.1-pro-preview",
      }),
    ).toMatchObject({
      project: "open-team-hack",
      location: "asia-northeast1",
      agentModel: "gemini-3-flash-preview",
      plannerModel: "gemini-3.1-pro-preview",
    });
  });

  it("空・空白だけの値は「ない」とみなして既定を使う", () => {
    expect(
      readGeminiEnv({ GOOGLE_CLOUD_PROJECT: "", GOOGLE_CLOUD_LOCATION: "  ", GEMINI_MODEL_AGENT: "", GEMINI_MODEL_PLANNER: " " }),
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

describe("missingGeminiEnv（D-47・ADR-032）", () => {
  it("GOOGLE_CLOUD_PROJECT がなければその名前を返す", () => {
    expect(missingGeminiEnv({})).toEqual(["GOOGLE_CLOUD_PROJECT"]);
    expect(missingGeminiEnv({ GOOGLE_CLOUD_PROJECT: "  " })).toEqual(["GOOGLE_CLOUD_PROJECT"]);
  });

  it("SO-ENV-07：GEMINI_API_KEY・GOOGLE_API_KEY が置かれていれば名前だけを返す（値は返さない）", () => {
    const names = missingGeminiEnv({ GOOGLE_CLOUD_PROJECT: "p", GEMINI_API_KEY: "secret-1", GOOGLE_API_KEY: "secret-2" });
    expect(names).toEqual(["GEMINI_API_KEY", "GOOGLE_API_KEY"]);
    expect(names.join(",")).not.toContain("secret");
  });

  it("そろっていれば空", () => {
    expect(missingGeminiEnv({ GOOGLE_CLOUD_PROJECT: "p", GEMINI_API_KEY: "" })).toEqual([]);
  });
});

describe("モデルの選び方（15_hackathon.md:587）", () => {
  const env = { agentModel: "flash-x", plannerModel: "pro-y" };

  it("LLM Proxy の phase はどれも Flash 系（エージェントの推論。formation-runtime.md §8-7）", () => {
    const phases: LlmPhase[] = ["investigate", "plan", "implement", "review", "report"];
    for (const phase of phases) expect(modelForPhase(env, phase)).toBe("flash-x");
  });

  it("設定プランナー・状況の生成・解釈・締める提案は上位、エージェント・要約は Flash 系", () => {
    expect(modelForPurpose(env, "planner")).toBe("pro-y");
    expect(modelForPurpose(env, "rehearsal_generate")).toBe("pro-y");
    expect(modelForPurpose(env, "rehearsal_interpret")).toBe("pro-y");
    expect(modelForPurpose(env, "rehearsal_tighten")).toBe("pro-y");
    expect(modelForPurpose(env, "agent")).toBe("flash-x");
    expect(modelForPurpose(env, "summary")).toBe("flash-x");
    expect(Object.keys(MODEL_ROLE_BY_PURPOSE).sort()).toEqual(
      ["agent", "planner", "rehearsal_generate", "rehearsal_interpret", "rehearsal_tighten", "summary"].sort(),
    );
  });

  it("modelForRole は役割のモデルを返す", () => {
    expect(modelForRole(env, "agent")).toBe("flash-x");
    expect(modelForRole(env, "planner")).toBe("pro-y");
  });
});
