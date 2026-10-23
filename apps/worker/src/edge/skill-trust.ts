// スキルの信頼の判定（SG-05。packages/edge/src/skill-trust.ts の写し）。スキルを信頼された手順書として扱うか、外から来た内容として扱うかを決める。
// - 信頼するのは次の2つだけ。名前と説明もシステムプロンプトの「# 使えるスキル」の区画に入るので、本文と一緒に照合する：
//   1. origin = 'pack'：運営のパックの定数（app の packs/catalog.ts）と同じ中身。
//      DB の行の (pack_id, name) でカタログの同じパックの同じ名前のスキルを引き、(名前, 説明, 本文) の SHA-256 が一致したとき。
//   2. origin = 'learned'（育ったスキル）：人が承認した中身と同じ。approved_digest が NULL でなく、今の (名前, 説明, 本文) の SHA-256 と一致したとき
//      （承認後に書き換えられたら一致しなくなる）。
// - それ以外（pack_id がない・カタログにない・承認した中身と違う・どれかが書き換えられた）は、システムプロンプトの区画に出さず（context.ts）、
//   load_skill で読んだら <untrusted> で包み、読んだタスクを skill で汚染する（sandbox.ts）。
// - パックの版は見ない：agent_skills の行は版を持たず（入れたときの版は pack_installs にだけある）、カタログは今の版の本文しか持たない。
//   カタログの本文が変われば、前の版で入れたスキルは一致しなくなり、包まれる側に倒れる（厳しい側）。
// - Node 版はカタログ（app の packs/catalog.ts）から作った表を createEdge に渡していた。WorkspaceDO 版（4c）はパックのカタログをまだ移していないので、
//   task-edge の表は空（NO_TRUSTED_SKILLS）。パックのスキルはどれも包まれる側に倒れ、承認した育ったスキル（approved_digest）だけを信頼する。
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

/** DB のスキルの行が、運営のパックの定数または人が承認した中身と同じ（名前・説明・本文）か */
export function isTrustedSkill(
  trusted: TrustedSkillDigests,
  skill: { pack_id: string | null; name: string; description: string; body: string; origin?: "pack" | "learned"; approved_digest?: string | null },
): boolean {
  // 育ったスキルは、人が承認したときの中身と一致するものだけ（カタログは見ない）。origin の省略は pack
  if (skill.origin === "learned") return typeof skill.approved_digest === "string" && skill.approved_digest === skillDigest(skill);
  if (skill.pack_id === null) return false;
  const want = trusted.get(skillTrustKey(skill.pack_id, skill.name));
  return want !== undefined && want === skillDigest(skill);
}
