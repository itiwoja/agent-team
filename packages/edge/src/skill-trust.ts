// スキルの信頼の判定（SG-05）。スキルを信頼された手順書として扱うか、外から来た内容として扱うかを決める。
// - 信頼するのは「運営のパックの定数（app の packs/catalog.ts）と同じ中身」のスキルだけ：
//   DB の行の (pack_id, name) でカタログの同じパックの同じ名前のスキルを引き、(名前, 説明, 本文) の SHA-256 が一致したとき。
//   名前と説明もシステムプロンプトの「# 使えるスキル」の区画に入るので、本文と一緒に照合する。
// - それ以外（pack_id がない・カタログにない・どれかが書き換えられた）は、システムプロンプトの区画に出さず（context.ts）、
//   load_skill で読んだら <untrusted> で包み、読んだタスクを skill で汚染する（sandbox.ts）。
// - パックの版は見ない：agent_skills の行は版を持たず（入れたときの版は pack_installs にだけある）、カタログは今の版の本文しか持たない。
//   カタログの本文が変われば、前の版で入れたスキルは一致しなくなり、包まれる側に倒れる（厳しい側）。
// - カタログは app にあり edge から import できないので、app が createEdge に渡す（EdgeDeps.trustedSkills）。渡さなければどれも信頼しない。
// SG-06（署名）ができたら、ここを「運営の鍵で署名を検証できたもの」に置き換える。

import { createHash } from "node:crypto";

/** (パック, スキル名) → (名前, 説明, 本文) の SHA-256（16進：skillDigest）。キーは skillTrustKey で作る */
export type TrustedSkillDigests = ReadonlyMap<string, string>;

export const NO_TRUSTED_SKILLS: TrustedSkillDigests = new Map();

/** スキルの (名前, 説明, 本文) の SHA-256（JSON の配列にしてから UTF-8 で。区切りが中身と混ざらない） */
export function skillDigest(skill: { name: string; description: string; body: string }): string {
  return createHash("sha256").update(JSON.stringify([skill.name, skill.description, skill.body]), "utf8").digest("hex");
}

/** 信頼の表のキー。パックの ID は [a-z0-9-] だけなので、区切りの改行が名前と混ざらない */
export function skillTrustKey(packId: string, name: string): string {
  return `${packId}\n${name}`;
}

/** 運営のパックの一覧から信頼の表を作る（app の catalog が使う） */
export function trustedSkillDigestsOf(
  packs: Iterable<{ id: string; skills: readonly { name: string; description: string; body: string }[] }>,
): TrustedSkillDigests {
  const out = new Map<string, string>();
  for (const p of packs) {
    for (const s of p.skills) out.set(skillTrustKey(p.id, s.name), skillDigest(s));
  }
  return out;
}

/** DB のスキルの行が、運営のパックの定数と同じ中身（名前・説明・本文）か */
export function isTrustedSkill(trusted: TrustedSkillDigests, skill: { pack_id: string | null; name: string; description: string; body: string }): boolean {
  if (skill.pack_id === null) return false;
  const want = trusted.get(skillTrustKey(skill.pack_id, skill.name));
  return want !== undefined && want === skillDigest(skill);
}
