import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { hashCanonical } from "./canonical.ts";
import {
  FORMATION_LIMITS,
  FORMATION_TEMPLATES_0H,
  TEAM_LIMITS,
  composeAnswer,
  failReasonText,
  haltReasonText,
  normalizeAgentName,
  shapeLine,
  validateFormation,
  validateTeamMessage,
} from "./formation.ts";
import type {
  AnswerMember,
  AnswerMemberTask,
  ComposeAnswerInput,
  FormationProposal,
  FormationViolationCode,
  ProposedMember,
  Shape,
  ValidateFormationInput,
} from "./formation.ts";
import { addTaintSource, taintFromInputs } from "./taint.ts";
import { EMPTY_TAINT } from "./types.ts";
import type { DirectTaintSource } from "./types.ts";

// ---- 編成案のフィクスチャ（FR §2.10：受信箱係 researcher・仕入れ係 assistant） ----
type Agent = ValidateFormationInput["workspace"]["agents"][number];
const INBOX: Agent = { agentId: "a-inbox", name: "受信箱係", status: "active", jobCount: 1, hasConnectorGrants: true };
const BUYER: Agent = { agentId: "a-buyer", name: "仕入れ係", status: "active", jobCount: 3, hasConnectorGrants: true };
const SUMMARY: Agent = { agentId: "a-sum", name: "まとめ係", status: "idle", jobCount: 0, hasConnectorGrants: false };
const TEMPLATES: ValidateFormationInput["templates"] = {
  researcher: { canWriteByLlm: false },
  briefer: { canWriteByLlm: false },
  assistant: { canWriteByLlm: true },
  watcher: { canWriteByLlm: false },
  "dev-coder": { canWriteByLlm: true },
};
const member = (position: number, over: Partial<ProposedMember> = {}): ProposedMember => ({
  agent: { kind: "new", name: `担当${position}係` },
  position,
  dependsOn: [],
  isSpokesperson: false,
  job: { template: "researcher", deliver: [] },
  grantsNeeded: { connectors: {} },
  ...over,
});
const existing = (a: Agent, position: number, over: Partial<ProposedMember> = {}) =>
  member(position, { agent: { kind: "existing", agentId: a.agentId }, ...over });
const chain = (n: number): FormationProposal => ({
  shape: "chain",
  members: Array.from({ length: n }, (_, k) => member(k + 1, { dependsOn: k === 0 ? [] : [k], isSpokesperson: k === n - 1 })),
});
const parallel = (n: number): FormationProposal => ({ shape: "parallel", members: Array.from({ length: n }, (_, k) => member(k + 1)) });
const aggregate = (n: number, agg: Partial<ProposedMember> = {}): FormationProposal => ({
  shape: "aggregate",
  members: Array.from({ length: n }, (_, k) => member(k + 1)),
  aggregator: member(n + 1, {
    agent: { kind: "new", name: "まとめ役" },
    dependsOn: Array.from({ length: n }, (_, k) => k + 1),
    isSpokesperson: true,
    job: { template: "briefer", deliver: [] },
    ...agg,
  }),
});
const validate = (proposal: FormationProposal, over: Partial<ValidateFormationInput> = {}) =>
  validateFormation({ proposal, workspace: { agents: [INBOX, BUYER, SUMMARY] }, mention: null, templates: TEMPLATES, ...over });
const codes = (r: ReturnType<typeof validateFormation>): FormationViolationCode[] => (r.ok ? [] : r.violations.map((v) => v.code));
const fillers = (n: number, status: Agent["status"] = "active"): Agent[] =>
  Array.from({ length: n }, (_, k) => ({ agentId: `f-${k}`, name: `係${k}`, status, jobCount: 0, hasConnectorGrants: false }));

describe("validateFormation（FR §3.3、agents.md:208-214、M-34）", () => {
  it("VF-01：single、既存の仕入れ係（active・仕事3）、窓口 true → ok", () => {
    expect(validate({ shape: "single", members: [existing(BUYER, 1, { isSpokesperson: true, job: { template: "assistant", deliver: [] } })] })).toEqual({
      ok: true,
    });
  });

  it("VF-02：single に担当2人 → SHAPE_MEMBER_COUNT（1つにまとめる）", () => {
    const r = validate({ shape: "single", members: [member(1, { isSpokesperson: true }), member(2)] });
    expect(codes(r).filter((c) => c === "SHAPE_MEMBER_COUNT")).toHaveLength(1);
  });

  it("VF-03：chain 2段（1→2）、2段目が窓口 → ok（用意した依頼の形）", () => {
    const p: FormationProposal = {
      shape: "chain",
      members: [
        existing(INBOX, 1),
        existing(BUYER, 2, { dependsOn: [1], isSpokesperson: true, job: { template: "assistant", deliver: [] }, grantsNeeded: { connectors: { supplier: ["place_order"] } } }),
      ],
    };
    expect(validate(p)).toEqual({ ok: true });
  });

  it("VF-04：chain 4段 → ok（境界）／VF-05：5段 → CHAIN_TOO_LONG", () => {
    expect(validate(chain(4))).toEqual({ ok: true });
    expect(codes(validate(chain(5)))).toEqual(["CHAIN_TOO_LONG"]);
  });

  it("chain 1段は SHAPE_MEMBER_COUNT（下限2は FR の提案）", () => {
    expect(codes(validate(chain(1)))).toContain("SHAPE_MEMBER_COUNT");
  });

  it("VF-06：chain の1段目が窓口 → SPOKESPERSON_INVALID", () => {
    const p = chain(2);
    const r = validate({ ...p, members: [member(1, { isSpokesperson: true }), member(2, { dependsOn: [1] })] });
    expect(codes(r)).toEqual(["SPOKESPERSON_INVALID", "SPOKESPERSON_INVALID"]);
  });

  it("VF-07：chain の窓口が2人 → SPOKESPERSON_INVALID（余計な方の段）", () => {
    const r = validate({ shape: "chain", members: [member(1, { isSpokesperson: true }), member(2, { dependsOn: [1], isSpokesperson: true })] });
    expect(r).toEqual({ ok: false, violations: [{ code: "SPOKESPERSON_INVALID", position: 1 }] });
  });

  it("VF-08：chain の1段目の dependsOn = [2] → DEPENDS_ON_INVALID", () => {
    const r = validate({ shape: "chain", members: [member(1, { dependsOn: [2] }), member(2, { dependsOn: [1], isSpokesperson: true })] });
    expect(codes(r)).toEqual(["DEPENDS_ON_INVALID"]);
  });

  it("VF-09：chain の position が 1・3 → POSITION_INVALID", () => {
    const r = validate({ shape: "chain", members: [member(1), member(3, { dependsOn: [2], isSpokesperson: true })] });
    expect(codes(r)).toContain("POSITION_INVALID");
  });

  it("段の番号の重なり・整数でない番号・編成にない段への依存", () => {
    expect(codes(validate({ shape: "parallel", members: [member(1), member(1)] }))).toContain("POSITION_INVALID");
    expect(codes(validate({ shape: "parallel", members: [member(1), member(1.5)] }))).toContain("POSITION_INVALID");
    expect(codes(validate({ shape: "parallel", members: [member(1), member(2, { dependsOn: [9] })] }))).toContain("DEPENDS_ON_INVALID");
    expect(codes(validate({ shape: "parallel", members: [member(1), member(2, { dependsOn: [1] })] }))).toEqual(["DEPENDS_ON_INVALID"]);
  });

  it("VF-10：担当0人 → SHAPE_MEMBER_COUNT", () => {
    expect(codes(validate({ shape: "single", members: [] }))).toEqual(["SHAPE_MEMBER_COUNT"]);
    expect(codes(validate({ shape: "chain", members: [] }))).toEqual(["SHAPE_MEMBER_COUNT"]);
  });

  it("VF-11：parallel 5人 → ok／6人 → SHAPE_MEMBER_COUNT（1つ）", () => {
    expect(validate(parallel(5))).toEqual({ ok: true });
    expect(codes(validate(parallel(6)))).toEqual(["SHAPE_MEMBER_COUNT"]);
    expect(codes(validate(parallel(1)))).toEqual(["SHAPE_MEMBER_COUNT"]);
  });

  it("VF-12：parallel で誰かが窓口 → SPOKESPERSON_INVALID", () => {
    const p = parallel(2);
    expect(codes(validate({ ...p, members: [member(1, { isSpokesperson: true }), member(2)] }))).toEqual(["SPOKESPERSON_INVALID"]);
  });

  it("VF-13：aggregate 2人＋まとめ役（窓口）→ ok", () => {
    expect(validate(aggregate(2))).toEqual({ ok: true });
  });

  it("VF-14：aggregate 1人＋まとめ役／VF-15：6人＋まとめ役 → SHAPE_MEMBER_COUNT", () => {
    expect(codes(validate(aggregate(1)))).toEqual(["SHAPE_MEMBER_COUNT"]);
    expect(codes(validate(aggregate(6)))).toEqual(["SHAPE_MEMBER_COUNT"]);
  });

  it("VF-16：aggregate でまとめ役なし → AGGREGATOR_MISSING／VF-17：chain にまとめ役 → AGGREGATOR_NOT_ALLOWED", () => {
    expect(codes(validate({ shape: "aggregate", members: [member(1), member(2)] }))).toEqual(["AGGREGATOR_MISSING"]);
    const withAgg = { ...chain(2), aggregator: member(3, { job: { template: "briefer", deliver: [] } }) };
    expect(codes(validate(withAgg))).toEqual(["AGGREGATOR_NOT_ALLOWED"]);
  });

  it("まとめ役の段の番号は n+1、依存は全担当", () => {
    expect(codes(validate(aggregate(2, { position: 5 })))).toContain("POSITION_INVALID");
    expect(codes(validate(aggregate(2, { dependsOn: [1] })))).toEqual(["DEPENDS_ON_INVALID"]);
    expect(codes(validate(aggregate(2, { dependsOn: [1, 1, 2] })))).toEqual(["DEPENDS_ON_INVALID"]);
  });

  it("aggregate では窓口はまとめ役だけ", () => {
    const p = aggregate(2, { isSpokesperson: false });
    expect(codes(validate(p))).toEqual(["SPOKESPERSON_INVALID"]);
    const q = aggregate(2);
    expect(codes(validate({ ...q, members: [member(1, { isSpokesperson: true }), member(2)] }))).toEqual(["SPOKESPERSON_INVALID"]);
  });

  it("VF-18：まとめ役のテンプレートが assistant → AGGREGATOR_HAS_WRITE（知らないテンプレートも書き込める側に倒す）", () => {
    expect(codes(validate(aggregate(2, { job: { template: "assistant", deliver: [] } })))).toEqual(["AGGREGATOR_HAS_WRITE"]);
    expect(codes(validate(aggregate(2, { job: { template: "mystery", deliver: [] } })))).toEqual(["AGGREGATOR_HAS_WRITE", "TEMPLATE_NOT_ALLOWED"]);
  });

  it("VF-19：まとめ役の grantsNeeded.connectors = { mail: [list_inbox] }（読み取りでも）→ AGGREGATOR_HAS_WRITE", () => {
    expect(codes(validate(aggregate(2, { grantsNeeded: { connectors: { mail: ["list_inbox"] } } })))).toEqual(["AGGREGATOR_HAS_WRITE"]);
  });

  it("VF-20：まとめ役の deliver に mcp.mail.send → AGGREGATOR_HAS_WRITE（notify はよい）", () => {
    expect(codes(validate(aggregate(2, { job: { template: "briefer", deliver: [{ to: "mcp.mail.send" }] } })))).toEqual(["AGGREGATOR_HAS_WRITE"]);
    expect(validate(aggregate(2, { job: { template: "briefer", deliver: [{ to: "notify" }] } }))).toEqual({ ok: true });
  });

  it("使い回すまとめ役に既存のコネクタの付与がある → AGGREGATOR_HAS_WRITE", () => {
    const p = aggregate(2, { agent: { kind: "existing", agentId: INBOX.agentId } });
    expect(codes(validate(p))).toEqual(["AGGREGATOR_HAS_WRITE"]);
    expect(validate(aggregate(2, { agent: { kind: "existing", agentId: SUMMARY.agentId } }))).toEqual({ ok: true });
  });

  it("違反には段の番号と理由を添える（まとめ役の違反はまとめ役の position）", () => {
    const r = validate(aggregate(2, { grantsNeeded: { connectors: { mail: ["list_inbox"] } }, job: { template: "assistant", deliver: [{ to: "mcp.mail.send" }] } }));
    expect(r).toEqual({
      ok: false,
      violations: [
        { code: "AGGREGATOR_HAS_WRITE", position: 3, detail: "書き込みを呼べるテンプレート" },
        { code: "AGGREGATOR_HAS_WRITE", position: 3, detail: "コネクタの付与" },
        { code: "AGGREGATOR_HAS_WRITE", position: 3, detail: "MCP の届け先" },
      ],
    });
  });

  it("VF-21：エージェント19体＋新しく1体 → ok（境界）／VF-22：20体＋新しく1体 → AGENT_LIMIT", () => {
    const single = (m: ProposedMember): FormationProposal => ({ shape: "single", members: [{ ...m, isSpokesperson: true }] });
    expect(validate(single(member(1)), { workspace: { agents: fillers(19) } })).toEqual({ ok: true });
    expect(codes(validate(single(member(1)), { workspace: { agents: fillers(20) } }))).toEqual(["AGENT_LIMIT"]);
  });

  it("VF-23：エージェント20体＋使い回しだけ → ok", () => {
    const agents = [...fillers(19), BUYER];
    expect(validate({ shape: "single", members: [existing(BUYER, 1, { isSpokesperson: true })] }, { workspace: { agents } })).toEqual({ ok: true });
  });

  it("VF-24：エージェント18体（ほかに removed 3体）＋新しく2体 → ok（removed は数えない）", () => {
    const agents = [...fillers(18), ...fillers(3, "removed").map((a, k) => ({ ...a, agentId: `r-${k}`, name: `消えた係${k}` }))];
    expect(validate(chain(2), { workspace: { agents } })).toEqual({ ok: true });
  });

  it("VF-25：新しい担当の名前「仕入れ係」（既存と同じ）→ NAME_CONFLICT", () => {
    const p: FormationProposal = { shape: "single", members: [member(1, { agent: { kind: "new", name: "仕入れ係" }, isSpokesperson: true })] };
    expect(codes(validate(p))).toEqual(["NAME_CONFLICT"]);
  });

  it("VF-26：新しい担当2人とも「受信箱係」（既存にない）→ NAME_CONFLICT（2人目）", () => {
    const p: FormationProposal = {
      shape: "chain",
      members: [member(1, { agent: { kind: "new", name: "調べ係" } }), member(2, { agent: { kind: "new", name: "調べ係" }, dependsOn: [1], isSpokesperson: true })],
    };
    const r = validate(p);
    expect(r.ok ? [] : r.violations).toEqual([{ code: "NAME_CONFLICT", position: 2, detail: "「調べ係」はもうある" }]);
  });

  it("VF-27：「仕入れ係 」（末尾の空白）・全角と半角・大文字小文字の違いも重なる（NFKC・trim・小文字）", () => {
    const named = (name: string): FormationProposal => ({ shape: "single", members: [member(1, { agent: { kind: "new", name }, isSpokesperson: true })] });
    expect(codes(validate(named("仕入れ係 ")))).toEqual(["NAME_CONFLICT"]);
    expect(codes(validate(named("　仕入れ係")))).toEqual(["NAME_CONFLICT"]);
    const latin: Agent = { agentId: "a-x", name: "Buyer", status: "active", jobCount: 0, hasConnectorGrants: false };
    expect(codes(validate(named("ＢＵＹＥＲ"), { workspace: { agents: [latin] } }))).toEqual(["NAME_CONFLICT"]);
    expect(normalizeAgentName(" ＢＵＹＥＲ　")).toBe("buyer");
  });

  it("removed のエージェントの名前とも重ならない（行は消さない）", () => {
    const gone: Agent = { agentId: "a-gone", name: "古い係", status: "removed", jobCount: 0, hasConnectorGrants: false };
    const p: FormationProposal = { shape: "single", members: [member(1, { agent: { kind: "new", name: "古い係" }, isSpokesperson: true })] };
    expect(codes(validate(p, { workspace: { agents: [gone] } }))).toEqual(["NAME_CONFLICT"]);
  });

  it("VF-28：新しい担当の名前が空／41文字 → NAME_INVALID（40文字はよい）", () => {
    const named = (name: string): FormationProposal => ({ shape: "single", members: [member(1, { agent: { kind: "new", name }, isSpokesperson: true })] });
    expect(codes(validate(named("   ")))).toEqual(["NAME_INVALID"]);
    expect(codes(validate(named("あ".repeat(41))))).toEqual(["NAME_INVALID"]);
    expect(validate(named("あ".repeat(40)))).toEqual({ ok: true });
    expect(validate(named("𠮷".repeat(40)))).toEqual({ ok: true }); // コードポイントで数える
  });

  it("VF-29：既存の agentId が別のワークスペースのもの → AGENT_NOT_IN_WORKSPACE", () => {
    const p: FormationProposal = { shape: "single", members: [member(1, { agent: { kind: "existing", agentId: "a-other-ws" }, isSpokesperson: true })] };
    expect(codes(validate(p))).toEqual(["AGENT_NOT_IN_WORKSPACE"]);
  });

  it("VF-30：使い回す担当が disabled（invalid・removed も）→ AGENT_NOT_USABLE。idle はよい", () => {
    for (const status of ["disabled", "invalid", "removed"] as const) {
      const a: Agent = { ...BUYER, status };
      expect(codes(validate({ shape: "single", members: [existing(a, 1, { isSpokesperson: true })] }, { workspace: { agents: [a] } }))).toEqual([
        "AGENT_NOT_USABLE",
      ]);
    }
    expect(validate({ shape: "single", members: [existing(SUMMARY, 1, { isSpokesperson: true })] })).toEqual({ ok: true });
  });

  it("VF-31：同じ担当が2段に出る → AGENT_DUPLICATED", () => {
    const p: FormationProposal = { shape: "chain", members: [existing(BUYER, 1), existing(BUYER, 2, { dependsOn: [1], isSpokesperson: true })] };
    expect(codes(validate(p))).toEqual(["AGENT_DUPLICATED"]);
  });

  it("VF-32：使い回す担当の仕事が10個 → JOB_LIMIT（9個は ok）", () => {
    const busy = (jobCount: number): Agent => ({ ...BUYER, jobCount });
    const p: FormationProposal = { shape: "single", members: [existing(BUYER, 1, { isSpokesperson: true })] };
    expect(validate(p, { workspace: { agents: [busy(9)] } })).toEqual({ ok: true });
    expect(codes(validate(p, { workspace: { agents: [busy(10)] } }))).toEqual(["JOB_LIMIT"]);
  });

  it("VF-33：mention = 仕入れ係、案は chain → MENTION_MISMATCH／VF-34：single で仕入れ係 → ok", () => {
    const c: FormationProposal = { shape: "chain", members: [existing(BUYER, 1), member(2, { dependsOn: [1], isSpokesperson: true })] };
    expect(codes(validate(c, { mention: { agentId: BUYER.agentId } }))).toEqual(["MENTION_MISMATCH"]);
    const s: FormationProposal = { shape: "single", members: [existing(BUYER, 1, { isSpokesperson: true })] };
    expect(validate(s, { mention: { agentId: BUYER.agentId } })).toEqual({ ok: true });
    const other: FormationProposal = { shape: "single", members: [existing(INBOX, 1, { isSpokesperson: true })] };
    expect(codes(validate(other, { mention: { agentId: BUYER.agentId } }))).toEqual(["MENTION_MISMATCH"]);
  });

  it("VF-35：テンプレート triager → TEMPLATE_NOT_ALLOWED。watcher（見張り）・dev-coder（実装）は 10/14 から編成で使える", () => {
    const p: FormationProposal = { shape: "single", members: [member(1, { job: { template: "triager", deliver: [] }, isSpokesperson: true })] };
    expect(codes(validate(p))).toEqual(["TEMPLATE_NOT_ALLOWED"]);
    const w: FormationProposal = { shape: "single", members: [member(1, { job: { template: "watcher", deliver: [] }, isSpokesperson: true })] };
    expect(codes(validate(w))).toEqual([]);
    expect(FORMATION_TEMPLATES_0H).toEqual(["researcher", "briefer", "assistant", "watcher", "dev-coder", "reviewer"]);
  });

  it("VF-36：違反が3つある案は3つとも返る", () => {
    const p: FormationProposal = {
      shape: "chain",
      members: [
        member(1, { job: { template: "triager", deliver: [] } }),
        member(2, { dependsOn: [], agent: { kind: "new", name: "仕入れ係" }, isSpokesperson: true }),
      ],
    };
    expect(codes(validate(p)).sort()).toEqual(["DEPENDS_ON_INVALID", "NAME_CONFLICT", "TEMPLATE_NOT_ALLOWED"]);
  });

  it("上限は差し替えられる（仮の値は実機で決め直す）", () => {
    expect(codes(validate(chain(3), { limits: { maxChainStages: 2 } }))).toEqual(["CHAIN_TOO_LONG"]);
    expect(FORMATION_LIMITS.maxChainStages).toBe(4);
    // undefined・NaN の差し替えは無視する（検査を弱めない）
    expect(codes(validate(chain(5), { limits: { maxChainStages: Number.NaN, maxMembers: undefined } }))).toEqual(["CHAIN_TOO_LONG"]);
  });

  it("形の読めない案は PROPOSAL_SCHEMA_INVALID（Zod の前の保険）", () => {
    expect(codes(validate({ shape: "circle" as Shape, members: [] }))).toEqual(["PROPOSAL_SCHEMA_INVALID"]);
    expect(codes(validate({ shape: "single", members: null } as unknown as FormationProposal))).toEqual(["PROPOSAL_SCHEMA_INVALID"]);
    expect(codes(validate({ shape: "single", members: [{ position: 1 }] } as unknown as FormationProposal))).toEqual(["PROPOSAL_SCHEMA_INVALID"]);
  });

  it("性質：正しく作った chain（2〜4段）・parallel（2〜5人）・aggregate（2〜5人）はいつも ok", () => {
    fc.assert(
      fc.property(fc.constantFrom("chain", "parallel", "aggregate"), fc.integer({ min: 2, max: 5 }), (shape, n) => {
        const p = shape === "chain" ? chain(Math.min(n, 4)) : shape === "parallel" ? parallel(n) : aggregate(n);
        expect(validate(p)).toEqual({ ok: true });
      }),
    );
  });
});

describe("shapeLine（entrance.md:91-96、UI §4.5）", () => {
  it("single は出さない（null）", () => {
    expect(shapeLine("single", [{ agentName: "仕入れ係", position: 1 }])).toBeNull();
  });
  it("E20-10：parallel 2人「2人がそれぞれ動いて、答えを1つにして届けます」", () => {
    expect(shapeLine("parallel", [{ agentName: "A", position: 1 }, { agentName: "B", position: 1 }])).toBe("2人がそれぞれ動いて、答えを1つにして届けます");
  });
  it("E20-11：aggregate（担当3＋まとめ役1）「3人が調べて、まとめ役が1つにして届けます」（まとめ役は数えない）", () => {
    const ms = [
      { agentName: "A", position: 1 },
      { agentName: "B", position: 2 },
      { agentName: "C", position: 3 },
      { agentName: "まとめ役", position: 4, isAggregator: true },
    ];
    expect(shapeLine("aggregate", ms)).toBe("3人が調べて、まとめ役が1つにして届けます");
  });
  it("E20-09：chain「受信箱係 → 仕入れ係 の順に進めて、仕入れ係が答えます」", () => {
    expect(shapeLine("chain", [{ agentName: "受信箱係", position: 1 }, { agentName: "仕入れ係", position: 2 }])).toBe(
      "受信箱係 → 仕入れ係 の順に進めて、仕入れ係が答えます",
    );
  });
  it("E20-12：chain 3段（配列の順は C,A,B）→ position で並べる", () => {
    const ms = [
      { agentName: "C", position: 3 },
      { agentName: "A", position: 1 },
      { agentName: "B", position: 2 },
    ];
    expect(shapeLine("chain", ms)).toBe("A → B → C の順に進めて、Cが答えます");
  });
  it("担当のいない chain は null", () => {
    expect(shapeLine("chain", [])).toBeNull();
  });
});

// ---- 回答のフィクスチャ ----
const AT = "2026-10-03T09:00:00.000Z";
const MAIL: DirectTaintSource = { kind: "mcp_read", connectorId: "c-mail", connectorSlug: "mail", connectorName: "メール", tool: "list_inbox", at: AT };
const inboxTaint = addTaintSource(EMPTY_TAINT, MAIL);
const buyerTaint = taintFromInputs([{ taskId: "t-inbox", agentName: "受信箱係", taint: inboxTaint }], AT);
const task = (over: Partial<AnswerMemberTask> = {}): AnswerMemberTask => ({
  id: "t-x",
  status: "completed",
  failReason: null,
  haltReason: null,
  taint: EMPTY_TAINT,
  report: { title: "報告", body: "本文" },
  ...over,
});
const am = (agentName: string, position: number, t: AnswerMemberTask | null, over: Partial<AnswerMember> = {}): AnswerMember => ({
  agentId: `a-${position}`,
  agentName,
  position,
  isAggregator: false,
  isSpokesperson: false,
  task: t,
  ...over,
});
const compose = (over: Partial<ComposeAnswerInput>) => composeAnswer({ shape: "single", members: [], pendingApprovals: 0, boardFacts: [], ...over });
// 用意した依頼（FR §2.10、HK-01）：受信箱係 completed（汚染）→ 仕入れ係 awaiting_approval（受け渡しで汚染）、確認待ち1件
const INBOX_TASK = task({ id: "t-inbox", taint: inboxTaint, report: { title: "新しいメール3通を要約しました", body: "うち1通は値上げの知らせ" } });
const BUYER_TASK = task({
  id: "t-buyer",
  status: "awaiting_approval",
  taint: buyerTaint,
  report: { title: "豆を20kg発注します", body: "豆が残り2kgなので20kg発注します。あなたの確認待ちです" },
});
const demo = (buyer: AnswerMemberTask = BUYER_TASK) =>
  compose({
    shape: "chain",
    members: [am("仕入れ係", 2, buyer, { isSpokesperson: true }), am("受信箱係", 1, INBOX_TASK)],
    pendingApprovals: 1,
  });

describe("composeAnswer（FR §3.7、agents.md:258-275、D-74）", () => {
  it("HK-01・AN-02・CH-12：順番の回答は最後の段（窓口）の本文。前の段は途中の経過に畳み、確認待ち1件と汚染の1行", () => {
    const a = demo();
    expect(a.conclusion).toBe("豆が残り2kgなので20kg発注します。あなたの確認待ちです");
    expect(a.answerTaskId).toBe("t-buyer");
    expect(a.spokesperson).toEqual({ agentId: "a-2", agentName: "仕入れ係" });
    expect(a.memberLines).toEqual([
      { agentName: "受信箱係", text: "新しいメール3通を要約しました", failed: false },
      { agentName: "仕入れ係", text: "豆を20kg発注します", failed: false },
    ]);
    expect(a.needsYou).toEqual({ pendingApprovals: 1, stoppedMembers: [] });
    expect(a.intermediate).toEqual([{ agentName: "受信箱係", body: "うち1通は値上げの知らせ" }]);
    expect(a.taintNote).toBe("外部の内容をもとにしています（受信箱係が読んだメール）");
  });

  it("CH-13：承認 → 実行のあと作り直すと「手が要るもの」と bodyHash だけが変わる（結論は同じ）", () => {
    const before = demo();
    const after = composeAnswer({
      shape: "chain",
      members: [am("受信箱係", 1, INBOX_TASK), am("仕入れ係", 2, { ...BUYER_TASK, status: "succeeded" }, { isSpokesperson: true })],
      pendingApprovals: 0,
      boardFacts: [],
    });
    expect(after.conclusion).toBe(before.conclusion);
    expect(after.needsYou).toEqual({ pendingApprovals: 0, stoppedMembers: [] });
    expect(after.bodyHash).not.toBe(before.bodyHash);
  });

  it("D-108：却下（送らない）のあとは、結論は担当の報告のまま、担当の行と手が要るものに「送らなかった」数が出る。0件なら鍵を足さない（前の bodyHash を変えない）", () => {
    const declined = composeAnswer({
      shape: "chain",
      members: [am("受信箱係", 1, INBOX_TASK), am("仕入れ係", 2, { ...BUYER_TASK, status: "completed", declinedWrites: 1 }, { isSpokesperson: true })],
      pendingApprovals: 0,
      boardFacts: [],
    });
    expect(declined.conclusion).toBe(BUYER_TASK.report!.body);
    expect(declined.memberLines[1]).toEqual({ agentName: "仕入れ係", text: "豆を20kg発注します（あなたの確認で1件を送りませんでした）", failed: false });
    expect(declined.needsYou).toEqual({ pendingApprovals: 0, stoppedMembers: [], declinedWrites: 1 });
    const none = composeAnswer({
      shape: "chain",
      members: [am("受信箱係", 1, INBOX_TASK), am("仕入れ係", 2, { ...BUYER_TASK, status: "succeeded", declinedWrites: 0 }, { isSpokesperson: true })],
      pendingApprovals: 0,
      boardFacts: [],
    });
    expect(none.needsYou).toEqual({ pendingApprovals: 0, stoppedMembers: [] });
    expect(none.bodyHash).toBe(
      composeAnswer({
        shape: "chain",
        members: [am("受信箱係", 1, INBOX_TASK), am("仕入れ係", 2, { ...BUYER_TASK, status: "succeeded" }, { isSpokesperson: true })],
        pendingApprovals: 0,
        boardFacts: [],
      }).bodyHash,
    );
  });

  it("AN-07：bodyHash は結論・行・手が要るもの・途中の経過・汚染の1行の正規形のハッシュ", () => {
    const a = demo();
    expect(a.bodyHash).toBe(
      hashCanonical({ conclusion: a.conclusion, memberLines: a.memberLines, needsYou: a.needsYou, intermediate: a.intermediate, taintNote: a.taintNote }),
    );
    expect(a.bodyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("AN-01：ひとりの回答は担当の本文そのまま＋Kernel の行（担当1行・確認の件数）", () => {
    const a = compose({ members: [am("仕入れ係", 1, task({ id: "t-1", report: { title: "在庫を確認", body: "在庫は足りています" } }), { isSpokesperson: true })] });
    expect(a).toMatchObject({
      answerTaskId: "t-1",
      conclusion: "在庫は足りています",
      memberLines: [{ agentName: "仕入れ係", text: "在庫を確認", failed: false }],
      needsYou: { pendingApprovals: 0, stoppedMembers: [] },
      intermediate: [],
      taintNote: null,
    });
  });

  it("AN-05：窓口のタスクが tainted なら汚染の1行（汚染されていなければ null）", () => {
    expect(demo().taintNote).toBe("外部の内容をもとにしています（受信箱係が読んだメール）");
    const clean = compose({ members: [am("仕入れ係", 1, task(), { isSpokesperson: true })] });
    expect(clean.taintNote).toBeNull();
  });

  it("PA-01：並列2人が両方 completed → Kernel が名前を見出しにして position の順に並べる（窓口なし）", () => {
    const a = compose({
      shape: "parallel",
      members: [am("B係", 2, task({ id: "t-b", report: { title: "B", body: "Bの結果" } })), am("A係", 1, task({ id: "t-a", report: { title: "A", body: "Aの結果" } }))],
    });
    expect(a.conclusion).toBe("## A係\n\nAの結果\n\n## B係\n\nBの結果");
    expect(a.answerTaskId).toBeNull();
    expect(a.spokesperson).toBeNull();
    expect(a.intermediate).toEqual([]);
  });

  it("PA-02：並列で1人 failed → 見出し「失敗：〇〇」と理由の固定文、もう1人の報告はそのまま", () => {
    const a = compose({
      shape: "parallel",
      members: [am("A係", 1, task({ report: { title: "A", body: "Aの結果" } })), am("B係", 2, task({ status: "failed", failReason: "llm_unavailable", report: null }))],
    });
    expect(a.conclusion).toBe("## A係\n\nAの結果\n\n## 失敗：B係\n\nAI につながりませんでした");
    expect(a.memberLines[1]).toEqual({ agentName: "B係", text: "失敗（AI につながりませんでした）", failed: true });
    expect(a.needsYou.stoppedMembers).toEqual(["B係"]);
  });

  it("並列：動いている担当は結論に入れない（終わった担当だけで回答：agents.md:271）。名前の改行は見出しで1行に", () => {
    const a = compose({
      shape: "parallel",
      members: [am("A\n係", 1, task({ report: { title: "A", body: "Aの結果" } })), am("B係", 2, task({ status: "running", report: null })), am("C係", 3, null)],
    });
    expect(a.conclusion).toBe("## A 係\n\nAの結果");
    expect(a.memberLines.map((l) => l.text)).toEqual(["A", "まだ終わっていません", "始まっていません"]);
  });

  it("並列：どれかの担当が tainted なら汚染の1行（FR §3.7-5）", () => {
    const a = compose({ shape: "parallel", members: [am("A係", 1, task()), am("B係", 2, task({ taint: inboxTaint }))] });
    expect(a.taintNote).toBe("外部の内容をもとにしています（メール）");
  });

  it("aggregate：まとめ役の報告が回答。PA-05：全員が失敗してまとめ役が動いていなければ Kernel の失敗の回答", () => {
    const ok = compose({
      shape: "aggregate",
      members: [am("A係", 1, task()), am("B係", 2, task()), am("まとめ役", 3, task({ id: "t-agg", report: { title: "比較", body: "比較表" } }), { isAggregator: true, isSpokesperson: true })],
    });
    expect(ok).toMatchObject({ conclusion: "比較表", answerTaskId: "t-agg", spokesperson: { agentId: "a-3", agentName: "まとめ役" } });
    const failed = compose({
      shape: "aggregate",
      members: [
        am("A係", 1, task({ status: "failed", failReason: "agent_unable", report: null })),
        am("B係", 2, task({ status: "failed", failReason: "llm_unavailable", report: null })),
        am("まとめ役", 3, null, { isAggregator: true, isSpokesperson: true }),
      ],
    });
    expect(failed.conclusion).toBe("A係で止まりました（できませんでした）");
    expect(failed.answerTaskId).toBeNull();
    expect(failed.spokesperson).toBeNull();
    expect(failed.needsYou.stoppedMembers).toEqual(["A係", "B係"]);
    expect(failed.memberLines.map((l) => l.text)).toEqual(["失敗（できませんでした）", "失敗（AI につながりませんでした）", "始まっていません"]);
  });

  it("CH-07：[ここまでで終える] は Kernel の回答「受信箱係で止まりました（…）」。後の段は始まっていない", () => {
    const a = compose({
      shape: "chain",
      members: [am("受信箱係", 1, task({ status: "failed", failReason: "llm_unavailable", report: null })), am("仕入れ係", 2, null, { isSpokesperson: true })],
      stoppedBeforeEnd: { agentName: "受信箱係", reason: failReasonText("llm_unavailable") },
    });
    expect(a.conclusion).toBe("受信箱係で止まりました（AI につながりませんでした）");
    expect(a.answerTaskId).toBeNull();
    expect(a.spokesperson).toBeNull();
    expect(a.memberLines).toEqual([
      { agentName: "受信箱係", text: "失敗（AI につながりませんでした）", failed: true },
      { agentName: "仕入れ係", text: "始まっていません", failed: false },
    ]);
    expect(a.needsYou.stoppedMembers).toEqual(["受信箱係"]);
  });

  it("CH-11：Kill Switch で止まった担当は「止めました」、窓口の報告がなければ「{名前}で止まりました（全体の停止で止めました）」", () => {
    const a = compose({
      shape: "chain",
      members: [am("受信箱係", 1, task({ status: "halted", haltReason: "kill_switch", report: null })), am("仕入れ係", 2, null, { isSpokesperson: true })],
    });
    expect(a.conclusion).toBe("受信箱係で止まりました（全体の停止で止めました）");
    expect(a.memberLines[0]).toEqual({ agentName: "受信箱係", text: "止めました", failed: false });
    expect(a.needsYou.stoppedMembers).toEqual(["受信箱係"]);
  });

  it("AN-08：連絡板で質問して返事が来なかった → 行に「受信箱係に確かめられませんでした」、来たら「確かめました」", () => {
    const members = [am("受信箱係", 1, INBOX_TASK), am("仕入れ係", 2, BUYER_TASK, { isSpokesperson: true })];
    const none = compose({ shape: "chain", members, boardFacts: [{ fromAgentName: "仕入れ係", toAgentName: "受信箱係", replied: false }] });
    expect(none.memberLines[1]?.text).toBe("豆を20kg発注します。受信箱係に確かめられませんでした");
    const replied = compose({
      shape: "chain",
      members,
      boardFacts: [
        { fromAgentName: "仕入れ係", toAgentName: "受信箱係", replied: false },
        { fromAgentName: "仕入れ係", toAgentName: "受信箱係", replied: true },
      ],
    });
    expect(replied.memberLines[1]?.text).toBe("豆を20kg発注します。受信箱係に確かめました");
    expect(replied.memberLines[0]?.text).toBe("新しいメール3通を要約しました");
  });

  it("窓口の報告があれば失敗（action_failed）でも結論はその本文、行は失敗", () => {
    const a = compose({ members: [am("仕入れ係", 1, task({ id: "t-1", status: "failed", failReason: "action_failed" }), { isSpokesperson: true })] });
    expect(a.conclusion).toBe("本文");
    expect(a.memberLines[0]).toEqual({ agentName: "仕入れ係", text: "失敗（送った操作が失敗しました）", failed: true });
  });

  it("窓口の印がなくても形から決める（chain は最後の段）。誰も止まっておらず報告もなければ「回答を作れませんでした」", () => {
    const a = compose({ shape: "chain", members: [am("A係", 1, task({ report: { title: "a", body: "途中" } })), am("B係", 2, task({ id: "t-b", report: { title: "b", body: "最後" } }))] });
    expect(a.conclusion).toBe("最後");
    expect(a.answerTaskId).toBe("t-b");
    expect(compose({ members: [am("A係", 1, task({ status: "running", report: null }), { isSpokesperson: true })] }).conclusion).toBe("回答を作れませんでした");
  });

  it("理由の固定文（知らない値は「理由不明」「止めました」）", () => {
    expect(failReasonText("sandbox_lost")).toBe("応答がなくなりました");
    expect(failReasonText(null)).toBe("理由不明");
    expect(failReasonText("constructor")).toBe("理由不明");
    expect(haltReasonText("budget_exceeded")).toBe("予算の上限に達しました");
    expect(haltReasonText("??")).toBe("止めました");
  });

  it("性質：同じ入力からは同じ回答・同じ bodyHash（LLM を通さない）。並び順によらない", () => {
    fc.assert(
      fc.property(fc.shuffledSubarray([0, 1, 2], { minLength: 3, maxLength: 3 }), (order) => {
        const ms = [am("A係", 1, task({ report: { title: "a", body: "x" } })), am("B係", 2, task({ taint: inboxTaint })), am("C係", 3, null)];
        const shuffled = order.map((k) => ms[k] as AnswerMember);
        const x = compose({ shape: "parallel", members: ms });
        const y = compose({ shape: "parallel", members: shuffled });
        expect(y).toEqual(x);
      }),
    );
  });
});

// ---- 連絡板の連絡の検査（FR §3.13 validateTeamMessage、BR-73・BR-77、ag:303-318。Should） ----

type TeamInput = Parameters<typeof validateTeamMessage>[0];
type TeamMember = TeamInput["members"][number];
type TeamHistory = TeamInput["history"][number];
const tm = (memberId: string, agentName: string, position: number, over: Partial<TeamMember> = {}): TeamMember => ({
  memberId,
  agentName,
  position,
  isAggregator: false,
  stopped: false,
  ...over,
});
const CHAIN_MEMBERS = [tm("m-inbox", "受信箱係", 1), tm("m-buyer", "仕入れ係", 2)];
const AGG_MEMBERS = [tm("m-1", "調べ係A", 1), tm("m-2", "調べ係B", 2), tm("m-agg", "まとめ役", 3, { isAggregator: true })];
const PAR_MEMBERS = [tm("m-1", "調べ係A", 1), tm("m-2", "調べ係B", 2), tm("m-3", "調べ係C", 3)];
const team = (over: Omit<Partial<TeamInput>, "message"> & { shape?: Shape; message?: Partial<TeamInput["message"]> } = {}): ReturnType<typeof validateTeamMessage> => {
  const shape = over.shape ?? "chain";
  const members = over.members ?? (shape === "aggregate" ? AGG_MEMBERS : shape === "parallel" ? PAR_MEMBERS : CHAIN_MEMBERS);
  return validateTeamMessage({
    ask: over.ask ?? { id: "ask-1", shape, boardOpen: true },
    members,
    fromMemberId: over.fromMemberId ?? "m-buyer",
    message: { to: "受信箱係", kind: "question", body: "振込先の変更は本物ですか", ...over.message },
    history: over.history ?? [],
  });
};
const hist = (id: string, fromMember: string, toMember: string | null, kind: TeamHistory["kind"], inReplyTo: string | null = null): TeamHistory => ({
  id,
  fromMember,
  toMember,
  kind,
  inReplyTo,
});

describe("validateTeamMessage（FR §3.13、BR-73・BR-77。連絡板は Should）", () => {
  it("TEAM_LIMITS は FR §2.1 の値（20通・同じ2体の question 3往復・revise 1回・本文 2,000文字・待ち300秒・追いのターン1）", () => {
    expect(TEAM_LIMITS).toEqual({ messagesPerAsk: 20, questionsPerPair: 3, revisePerMember: 1, bodyMaxChars: 2000, waitMaxSec: 300, followupTurns: 1 });
  });
  it("TB-01 の前半：順番の後の段（仕入れ係）→ 前の段（受信箱係）の question は ok（宛先の member を返す）", () => {
    expect(team()).toEqual({ ok: true, toMemberId: "m-inbox" });
  });
  it("TB-02：順番の前の段 → 後の段の question → kind_not_allowed_for_shape", () => {
    expect(team({ fromMemberId: "m-inbox", message: { to: "仕入れ係" } })).toEqual({ ok: false, reason: "kind_not_allowed_for_shape" });
  });
  it("TB-03・TB-04：順番の share は前の段 → 後の段だけ（1 → 2 は ok、2 → 1 は kind_not_allowed_for_shape）", () => {
    expect(team({ fromMemberId: "m-inbox", message: { to: "仕入れ係", kind: "share" } })).toEqual({ ok: true, toMemberId: "m-buyer" });
    expect(team({ message: { kind: "share" } })).toEqual({ ok: false, reason: "kind_not_allowed_for_shape" });
  });
  it("TB-05：まとめで担当 → 担当の revise → revise_not_from_aggregator", () => {
    expect(team({ shape: "aggregate", fromMemberId: "m-1", message: { to: "調べ係B", kind: "revise" } })).toEqual({ ok: false, reason: "revise_not_from_aggregator" });
  });
  it("TB-06：まとめ役 → 担当の revise は1回目 ok、同じ担当への2回目は revise_limit（別の担当へはまた1回）", () => {
    const first = team({ shape: "aggregate", fromMemberId: "m-agg", message: { to: "調べ係A", kind: "revise" } });
    expect(first).toEqual({ ok: true, toMemberId: "m-1" });
    const history = [hist("x1", "m-agg", "m-1", "revise")];
    expect(team({ shape: "aggregate", fromMemberId: "m-agg", message: { to: "調べ係A", kind: "revise" }, history })).toEqual({ ok: false, reason: "revise_limit" });
    expect(team({ shape: "aggregate", fromMemberId: "m-agg", message: { to: "調べ係B", kind: "revise" }, history })).toEqual({ ok: true, toMemberId: "m-2" });
  });
  it("TB-07：別の依頼の担当の名前・自分宛て・送り手が依頼にいない → recipient_not_in_ask（BR-73）", () => {
    expect(team({ message: { to: "経理係" } })).toEqual({ ok: false, reason: "recipient_not_in_ask" });
    expect(team({ message: { to: "仕入れ係" } })).toEqual({ ok: false, reason: "recipient_not_in_ask" });
    expect(team({ fromMemberId: "m-other" })).toEqual({ ok: false, reason: "recipient_not_in_ask" });
  });
  it("名前は正規化して照合する（前後の空白・全角半角・大文字小文字。validateFormation の V10 と同じ）", () => {
    expect(team({ message: { to: " 受信箱係 " } })).toEqual({ ok: true, toMemberId: "m-inbox" });
    const members = [tm("m-a", "Inbox", 1), tm("m-b", "Buyer", 2)];
    expect(team({ members, fromMemberId: "m-b", message: { to: "ｉｎｂｏｘ" } })).toEqual({ ok: true, toMemberId: "m-a" });
  });
  it("TB-08：受け付けた連絡が19通なら20通目は ok、20通あれば21通目は ask_message_limit（種類を問わない）", () => {
    const shares = (n: number) => Array.from({ length: n }, (_, k) => hist(`s${k}`, "m-inbox", "m-buyer", "share"));
    expect(team({ history: shares(19) })).toEqual({ ok: true, toMemberId: "m-inbox" });
    expect(team({ history: shares(20) })).toEqual({ ok: false, reason: "ask_message_limit" });
  });
  it("TB-09：同じ2体の question は3件目まで ok、4件目は question_pair_limit（向きが逆のものも数える）", () => {
    const members = PAR_MEMBERS;
    const two = [hist("q1", "m-1", "m-2", "question"), hist("q2", "m-2", "m-1", "question")];
    expect(team({ shape: "parallel", members, fromMemberId: "m-1", message: { to: "調べ係B" }, history: two })).toEqual({ ok: true, toMemberId: "m-2" });
    const three = [...two, hist("q3", "m-1", "m-2", "question")];
    expect(team({ shape: "parallel", members, fromMemberId: "m-2", message: { to: "調べ係A" }, history: three })).toEqual({ ok: false, reason: "question_pair_limit" });
    // 別の2体の question は数えない
    expect(team({ shape: "parallel", members, fromMemberId: "m-1", message: { to: "調べ係C" }, history: three })).toEqual({ ok: true, toMemberId: "m-3" });
  });
  it("TB-10：本文 2,000文字は ok、2,001文字は body_too_long、空白だけは body_empty（コードポイントで数える）", () => {
    expect(team({ message: { body: "あ".repeat(2000) } })).toEqual({ ok: true, toMemberId: "m-inbox" });
    expect(team({ message: { body: "あ".repeat(2001) } })).toEqual({ ok: false, reason: "body_too_long" });
    expect(team({ message: { body: "😀".repeat(2000) } })).toEqual({ ok: true, toMemberId: "m-inbox" });
    expect(team({ message: { body: " \n　" } })).toEqual({ ok: false, reason: "body_empty" });
  });
  it("TB-13：連絡板が閉じている（Kill Switch・依頼の取り消し）→ board_closed（ほかの違反より先）", () => {
    expect(team({ ask: { id: "ask-1", shape: "chain", boardOpen: false }, message: { body: "" } })).toEqual({ ok: false, reason: "board_closed" });
  });
  it("ひとりの依頼には連絡板がない → single_shape", () => {
    expect(team({ shape: "single", members: [tm("m-buyer", "仕入れ係", 1)] })).toEqual({ ok: false, reason: "single_shape" });
  });
  it("TB-14：止まった担当宛て → recipient_stopped", () => {
    const members = [tm("m-inbox", "受信箱係", 1, { stopped: true }), tm("m-buyer", "仕入れ係", 2)];
    expect(team({ members })).toEqual({ ok: false, reason: "recipient_stopped" });
  });
  it("TB-15：reply の inReplyTo が自分宛ての question でない・相手が質問した担当でない・返事済み → reply_target_invalid", () => {
    const q = hist("q1", "m-buyer", "m-inbox", "question");
    const reply = (over: Partial<TeamInput["message"]>, history: TeamHistory[] = [q]) =>
      team({ fromMemberId: "m-inbox", message: { to: "仕入れ係", kind: "reply", inReplyTo: "q1", ...over }, history });
    expect(reply({})).toEqual({ ok: true, toMemberId: "m-buyer" });
    expect(reply({ inReplyTo: undefined })).toEqual({ ok: false, reason: "reply_target_invalid" });
    expect(reply({ inReplyTo: "nope" })).toEqual({ ok: false, reason: "reply_target_invalid" });
    expect(reply({}, [hist("q1", "m-inbox", "m-buyer", "share")])).toEqual({ ok: false, reason: "reply_target_invalid" });
    expect(reply({}, [q, hist("r1", "m-inbox", "m-buyer", "reply", "q1")])).toEqual({ ok: false, reason: "reply_target_invalid" });
    // 自分宛てでない質問（受信箱係 → 仕入れ係の question）に受信箱係が返事
    expect(reply({}, [hist("q1", "m-inbox", "m-buyer", "question")])).toEqual({ ok: false, reason: "reply_target_invalid" });
  });
  it("形と種類の表（ag:303-308）：まとめの question は担当どうし・まとめ役 → 担当、担当 → まとめ役は不可。share にまとめ役は入らない", () => {
    const agg = (fromMemberId: string, to: string, kind: TeamInput["message"]["kind"]) => team({ shape: "aggregate", fromMemberId, message: { to, kind } });
    expect(agg("m-1", "調べ係B", "question")).toEqual({ ok: true, toMemberId: "m-2" });
    expect(agg("m-agg", "調べ係A", "question")).toEqual({ ok: true, toMemberId: "m-1" });
    expect(agg("m-1", "まとめ役", "question")).toEqual({ ok: false, reason: "kind_not_allowed_for_shape" });
    expect(agg("m-1", "調べ係B", "share")).toEqual({ ok: true, toMemberId: "m-2" });
    expect(agg("m-agg", "調べ係A", "share")).toEqual({ ok: false, reason: "kind_not_allowed_for_shape" });
    expect(agg("m-1", "まとめ役", "share")).toEqual({ ok: false, reason: "kind_not_allowed_for_shape" });
    // 並列：share・question は担当どうし。revise はまとめ役がいないので不可
    expect(team({ shape: "parallel", fromMemberId: "m-1", message: { to: "調べ係C", kind: "share" } })).toEqual({ ok: true, toMemberId: "m-3" });
    expect(team({ shape: "parallel", fromMemberId: "m-1", message: { to: "調べ係C", kind: "revise" } })).toEqual({ ok: false, reason: "revise_not_from_aggregator" });
    // 知らない種類
    expect(team({ message: { kind: "order" as never } })).toEqual({ ok: false, reason: "kind_not_allowed_for_shape" });
  });
  it("宛先 'all' は share だけ（全員に share できる送り手のときだけ。toMemberId は null）", () => {
    expect(team({ shape: "parallel", fromMemberId: "m-1", message: { to: "all", kind: "share" } })).toEqual({ ok: true, toMemberId: null });
    expect(team({ shape: "aggregate", fromMemberId: "m-1", message: { to: "all", kind: "share" } })).toEqual({ ok: true, toMemberId: null });
    expect(team({ fromMemberId: "m-inbox", message: { to: "all", kind: "share" } })).toEqual({ ok: true, toMemberId: null });
    // 順番の後の段からの全員は前の段を含むので不可。まとめ役は share をしない
    expect(team({ message: { to: "all", kind: "share" } })).toEqual({ ok: false, reason: "kind_not_allowed_for_shape" });
    expect(team({ shape: "aggregate", fromMemberId: "m-agg", message: { to: "all", kind: "share" } })).toEqual({ ok: false, reason: "kind_not_allowed_for_shape" });
    // share 以外の 'all' は担当の名前として探す（ないので recipient_not_in_ask）
    expect(team({ message: { to: "all", kind: "question" } })).toEqual({ ok: false, reason: "recipient_not_in_ask" });
  });
  it("性質：同じ入力からは同じ結果（純粋）。違反の順は 閉じた → ひとり → 本文 → 宛先 → 種類 → 上限", () => {
    expect(team({ ask: { id: "a", shape: "single", boardOpen: false } })).toEqual({ ok: false, reason: "board_closed" });
    expect(team({ shape: "single", members: [tm("m-buyer", "仕入れ係", 1)], message: { body: "" } })).toEqual({ ok: false, reason: "single_shape" });
    expect(team({ message: { body: "", to: "経理係" } })).toEqual({ ok: false, reason: "body_empty" });
    expect(team({ message: { to: "経理係", kind: "revise" } })).toEqual({ ok: false, reason: "recipient_not_in_ask" });
    const many = Array.from({ length: 20 }, (_, k) => hist(`s${k}`, "m-inbox", "m-buyer", "share"));
    expect(team({ fromMemberId: "m-inbox", message: { to: "仕入れ係", kind: "question" }, history: many })).toEqual({ ok: false, reason: "kind_not_allowed_for_shape" });
    fc.assert(
      fc.property(fc.constantFrom("share", "question", "reply", "revise"), fc.constantFrom("受信箱係", "仕入れ係", "all", "x"), (kind, to) => {
        const input = { message: { to, kind: kind as TeamInput["message"]["kind"] } };
        expect(team(input)).toEqual(team(input));
      }),
    );
  });
});
