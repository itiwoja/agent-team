// パックの棚（D-116）の中身の試験：どのパックも入れられる形か（担当の定義・スキル・ファイル）と、
// 作業場に置くスクリプトが見本のデータで実際に動くか（python3 で動かす）
import { defaultWorkspacePolicy, initialAgentDefinition, type AgentDefinitionInput } from "@open-team/kernel";
import { safeRelativePath } from "@open-team/sandbox";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withJob } from "../asks/create.ts";
import { catalogOf } from "../owner-setup.ts";
import { isTrustedSkill } from "@open-team/edge";
import { PACK_CATEGORIES, PACKS, TRUSTED_SKILLS, type PackAgent } from "./catalog.ts";
import { PackViewSchema } from "./contract.ts";
import { packAgentIdsOf, packView } from "./install.ts";

const policy = defaultWorkspacePolicy("owner");

describe("パックの棚の中身", () => {
  it("id・担当の名前・担当の key が重ならず、どの分類にも1つ以上ある", () => {
    expect(new Set(PACKS.map((p) => p.id)).size).toBe(PACKS.length);
    const names = PACKS.flatMap((p) => p.agents.map((a) => a.name));
    expect(new Set(names).size).toBe(names.length);
    for (const p of PACKS) expect(new Set(p.agents.map((a) => a.key)).size).toBe(p.agents.length);
    for (const c of PACK_CATEGORIES) expect(PACKS.some((p) => p.category === c)).toBe(true);
  });

  it.each(PACKS.map((p) => [p.id, p] as const))("%s：担当の定義が組め、スキルとファイルがそろい、例の依頼がある", (_id, p) => {
    expect(p.agents.length).toBeGreaterThan(0);
    expect(p.examples.length).toBeGreaterThan(0);
    expect(PACK_CATEGORIES).toContain(p.category);
    const skillNames = new Set(p.skills.map((s) => s.name));
    expect(skillNames.size).toBe(p.skills.length);
    // 誰も読まないスキルは置かない
    for (const s of p.skills) expect(p.agents.some((a) => a.skills.includes(s.name))).toBe(true);
    for (const a of p.agents) {
      for (const n of a.skills) expect(skillNames.has(n)).toBe(true);
      const paths = (a.files ?? []).map((f) => f.path);
      for (const f of paths) expect(safeRelativePath(f)).toBe(f);
      expect(new Set(paths).size).toBe(paths.length);
      // ファイルを置くのは作業場を使う担当だけ
      if (paths.length > 0) expect(["dev-coder", "reviewer"]).toContain(a.template);
      const initial = initialAgentDefinition({ name: a.name, role: a.role, workspacePolicy: policy, workspaceKind: "owner" });
      const base = { ...(initial as unknown as AgentDefinitionInput), grants: { ...(initial.grants.web === undefined ? {} : { web: initial.grants.web }), connectors: {} } };
      expect(() => withJob(base, { slug: `pack-${a.key}`, kind: "once", template: a.template, instructions: a.instructions }, { policy, catalog: catalogOf([], []) }, a.name)).not.toThrow();
    }
  });
});

describe("スキルの信頼の表（SG-05）", () => {
  it("どのパックのどのスキルも、(パック, 名前) で (名前, 説明, 本文) の SHA-256 が引ける。ほかのパックの名前では引けない", () => {
    const n = PACKS.reduce((k, p) => k + p.skills.length, 0);
    expect(TRUSTED_SKILLS.size).toBe(n);
    for (const p of PACKS) {
      for (const sk of p.skills) {
        expect(isTrustedSkill(TRUSTED_SKILLS, { pack_id: p.id, ...sk })).toBe(true);
        expect(isTrustedSkill(TRUSTED_SKILLS, { pack_id: null, ...sk })).toBe(false);
        expect(isTrustedSkill(TRUSTED_SKILLS, { pack_id: "no-such-pack", ...sk })).toBe(false);
        // 説明だけ・本文だけを書き換えても一致しない
        expect(isTrustedSkill(TRUSTED_SKILLS, { pack_id: p.id, ...sk, description: `${sk.description}。` })).toBe(false);
        expect(isTrustedSkill(TRUSTED_SKILLS, { pack_id: p.id, ...sk, body: `${sk.body}\n` })).toBe(false);
      }
    }
  });
});

/** スクリプトごとの見本の動かし方と、出力に出るはずの言葉 */
const RUNS: Record<string, { args: string[]; expect: string[]; files?: string[] }> = {
  "grade.py": { args: ["samples/answers.csv", "samples/key.csv"], expect: ["3人を採点しました"], files: ["scores.csv", "item_analysis.csv"] },
  "contrast.py": { args: ["#333333", "#ffffff", "#9a9a9a", "#ffffff"], expect: ["#333333,#ffffff,12.63,OK", "#9a9a9a,#ffffff,2.81,NG"] },
  "palette.py": { args: ["#3b82f6"], expect: ["50: #", "900: #"] },
  "pipeline.py": { args: ["samples/deals.csv"], expect: ["| 交渉 | 1 | 800,000 | 560,000 |", "合計：4件", "| 2026-11 | 1,040,000 |"] },
  "expenses.py": { args: ["samples/expenses.csv", "rules.csv"], expect: ["| 旅費交通費 |", "要確認 1件"], files: ["classified.csv"] },
  "reconcile.py": { args: ["samples/invoices.csv", "samples/payments.csv"], expect: ["## 未入金（1件）", "INV-003", "差 -660円", "ミナミ工業"] },
  "flashcards.py": { args: ["samples/words.csv", "3"], expect: ["5語を cards.tsv に、3問を quiz.md に書きました"], files: ["cards.tsv", "quiz.md"] },
  "sales.py": { args: ["samples/sales.csv"], expect: ["売上 63,500円", "| ブレンド | 100 | 45,000 | 71% | A |"] },
};

const scripts: Array<[string, PackAgent]> = PACKS.flatMap((p) => p.agents.flatMap((a) => (a.files ?? []).filter((f) => f.path.endsWith(".py")).map((f) => [f.path, a] as [string, PackAgent])));

describe("パックのスクリプト（python3 で見本を動かす）", () => {
  it("どのスクリプトにも見本の動かし方がある", () => {
    expect(scripts.map(([f]) => f).sort()).toEqual(Object.keys(RUNS).sort());
  });

  it.each(scripts)("%s が見本のデータで動く", (file, agent) => {
    const root = mkdtempSync(path.join(tmpdir(), "pack-script-"));
    for (const f of agent.files ?? []) {
      mkdirSync(path.dirname(path.join(root, f.path)), { recursive: true });
      writeFileSync(path.join(root, f.path), f.content);
    }
    const run = RUNS[file]!;
    const out = execFileSync("python3", ["-I", file, ...run.args], { cwd: root, encoding: "utf8", timeout: 20_000 });
    for (const e of run.expect) expect(out).toContain(e);
    for (const f of run.files ?? []) expect(readFileSync(path.join(root, f), "utf8").length).toBeGreaterThan(0);
  });
});

describe("棚の形（packView）の担当の id", () => {
  const teacher = PACKS.find((p) => p.id === "teacher")!;
  const ids = teacher.agents.map((_, i) => `0000000${i}-0000-4000-8000-000000000000`);

  it("入れていなければ、どの担当も agentId は null", () => {
    const v = PackViewSchema.parse(packView(teacher, { installedAt: null, sandboxAvailable: true, agentIds: packAgentIdsOf(teacher, undefined) }));
    expect(v.agents.map((a) => a.agentId)).toEqual(teacher.agents.map(() => null));
    expect(packView(teacher, { installedAt: null, sandboxAvailable: true }).agents.every((a) => a.agentId === null)).toBe(true);
  });

  it("入れていれば、pack_installs.agent_ids を pack.agents と同じ順で入れる", () => {
    const v = PackViewSchema.parse(
      packView(teacher, { installedAt: new Date(0), sandboxAvailable: true, agentIds: packAgentIdsOf(teacher, { pack_version: teacher.version, agent_ids: ids }) }),
    );
    expect(v.agents.map((a) => [a.name, a.agentId])).toEqual(teacher.agents.map((a, i) => [a.name, ids[i]]));
  });

  it("agent_ids が足りない・版が違うときは、対応しないところを null にして落ちない", () => {
    expect(packAgentIdsOf(teacher, { pack_version: teacher.version, agent_ids: ids.slice(0, 1) })).toEqual([ids[0], ...teacher.agents.slice(1).map(() => null)]);
    expect(packAgentIdsOf(teacher, { pack_version: teacher.version + 1, agent_ids: ids })).toEqual(teacher.agents.map(() => null));
  });
});
