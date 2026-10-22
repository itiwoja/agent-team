// スキルの信頼の判定（SG-05）：パックはカタログと一致、育ったスキル（learned）は承認した中身と一致したときだけ信頼する
import { describe, expect, it } from "vitest";
import { isTrustedSkill, NO_TRUSTED_SKILLS, skillDigest, trustedSkillDigestsOf } from "./skill-trust.ts";

const S = { name: "手順", description: "説明", body: "本文" };
const TRUSTED = trustedSkillDigestsOf([{ id: "teacher", skills: [S] }]);

describe("isTrustedSkill", () => {
  it("learned：承認した digest と一致すれば信頼する（カタログは見ない）", () => {
    expect(isTrustedSkill(NO_TRUSTED_SKILLS, { ...S, pack_id: null, origin: "learned", approved_digest: skillDigest(S) })).toBe(true);
  });
  it("learned：承認後に本文・説明・名前を書き換えたら信頼しない", () => {
    const approved = skillDigest(S);
    for (const edit of [{ body: "書き換え" }, { description: "書き換え" }, { name: "書き換え" }]) {
      expect(isTrustedSkill(NO_TRUSTED_SKILLS, { ...S, ...edit, pack_id: null, origin: "learned", approved_digest: approved })).toBe(false);
    }
  });
  it("learned：approved_digest が null なら信頼しない", () => {
    expect(isTrustedSkill(NO_TRUSTED_SKILLS, { ...S, pack_id: null, origin: "learned", approved_digest: null })).toBe(false);
  });
  it("pack：カタログと一致すれば信頼し、違えば信頼しない（approved_digest は見ない）", () => {
    expect(isTrustedSkill(TRUSTED, { ...S, pack_id: "teacher", origin: "pack", approved_digest: null })).toBe(true);
    expect(isTrustedSkill(TRUSTED, { ...S, body: "x", pack_id: "teacher", origin: "pack", approved_digest: skillDigest({ ...S, body: "x" }) })).toBe(false);
    expect(isTrustedSkill(TRUSTED, { ...S, pack_id: null, origin: "pack", approved_digest: null })).toBe(false);
    expect(isTrustedSkill(NO_TRUSTED_SKILLS, { ...S, pack_id: "teacher", origin: "pack", approved_digest: null })).toBe(false);
  });
});
