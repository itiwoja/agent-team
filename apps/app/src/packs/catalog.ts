// パック（D-116）：複数のエージェント・スキル（手順書）・ツール（作業場に置くスクリプト）をひとまとめにした詰め合わせ。
// 運営が用意する。入れると、エージェントがライブラリに並び、スキルとスクリプトがその担当に付く（packs/install.ts）。
// 担当の名前は依頼から作る担当と同じ方針（何の担当か分かって、クスッとできる呼び名：asks/planner.ts）。
// 中身は library/ に1パック1ファイル。棚の並びはここの順
// スキルの本文の SHA-256（TRUSTED_SKILLS）を edge に渡し、load_skill はこれと同じ中身のスキルだけを信頼して渡す（SG-05）
import { trustedSkillDigestsOf, type TrustedSkillDigests } from "@open-team/edge";
import { ACCOUNTING } from "./library/accounting.ts";
import { DESIGNER } from "./library/designer.ts";
import { ENGINEER } from "./library/engineer.ts";
import { EXECUTIVE } from "./library/executive.ts";
import { MARKETER } from "./library/marketer.ts";
import { SALES } from "./library/sales.ts";
import { SHOP } from "./library/shop.ts";
import { STUDENT } from "./library/student.ts";
import { TEACHER } from "./library/teacher.ts";
import type { PackDefinition } from "./types.ts";

export { PACK_CATEGORIES, type PackAgent, type PackCategory, type PackDefinition, type PackFile, type PackSkill, type PackTemplate } from "./types.ts";

export const PACKS: readonly PackDefinition[] = [TEACHER, DESIGNER, ENGINEER, SALES, ACCOUNTING, STUDENT, SHOP, EXECUTIVE, MARKETER];

/**
 * 運営のパックのスキルの (パック, 名前) → 本文の SHA-256（SG-05）。createEdge の trustedSkills に渡す。
 * DB の agent_skills の本文がこれと一致しなければ（書き換えられた・カタログにない）、load_skill は <untrusted> で包んでタスクを汚染する
 */
export const TRUSTED_SKILLS: TrustedSkillDigests = trustedSkillDigestsOf(PACKS);

export function findPack(id: string): PackDefinition | undefined {
  return PACKS.find((p) => p.id === id);
}

/** 作業場が要る担当（dev-coder・reviewer）がいるか */
export function packNeedsSandbox(p: PackDefinition): boolean {
  return p.agents.some((a) => a.template === "dev-coder" || a.template === "reviewer");
}
