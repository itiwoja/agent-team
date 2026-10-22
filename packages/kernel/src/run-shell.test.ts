// SG-07：run_shell（作業場の任意のコマンド）の Hard Ceiling・既定・合成・分類・判定・古い定義との互換と、
// run_command の写し先に使う汚染（taintedByOutsideContent）の試験。写し先の形の表は operations.test.ts
import { describe, expect, it } from "vitest";
import { classify } from "./classify.ts";
import { compose } from "./compose.ts";
import { decide, nextCounters } from "./decide.ts";
import { operationOfCommand } from "./operations.ts";
import {
  CATALOG_DEFAULT_AUTONOMY,
  DEFAULT_CEILINGS,
  clampAutonomyToCeiling,
  defaultWorkspacePolicy,
  parseWorkspacePolicy,
  validateAgentDefinition,
  writableAutonomy,
} from "./policy.ts";
import type { AgentDefinitionInput, ClassifyContext, WorkspacePolicy } from "./index.ts";
import { TAINT_SOURCES_MAX, addTaintSource, taintOnWorkspaceSnapshot, taintedByOutsideContent } from "./taint.ts";
import { EMPTY_TAINT } from "./types.ts";
import type { Counters, DirectTaintSource, EffectivePolicy, Flags, Subject, TaintState } from "./types.ts";

const AT = "2026-10-14T09:00:00+09:00";

function coder(autonomy: AgentDefinitionInput["autonomy"] = {}): AgentDefinitionInput {
  return {
    version: 2,
    name: "コード職人",
    role: "dev",
    grants: { connectors: {} },
    autonomy,
    rules: [],
    budget: { per_task_usd: 0.2, per_day_usd: 1 },
    max_runs_per_day: 10,
    profile: [],
    jobs: [{ id: "build", kind: "once", template: "dev-coder", instructions: "作って動かす", trigger: null, deliver: [], guards: [] }],
  };
}

function ws(runShell?: WorkspacePolicy["autonomy"]["run_shell"]): WorkspacePolicy {
  const w = defaultWorkspacePolicy();
  return runShell === undefined ? w : { ...w, autonomy: { ...w.autonomy, run_shell: runShell } };
}

const ctxOf = (w: WorkspacePolicy): ClassifyContext => ({ ceilings: DEFAULT_CEILINGS, workspacePolicy: w, tools: {} });
const effOf = (agent: AgentDefinitionInput, w: WorkspacePolicy = ws()) => compose({ ceilings: DEFAULT_CEILINGS, workspacePolicy: w, agent }, "build");

const COUNTERS: Counters = {
  stepsUsed: 0,
  costUsd: 0,
  dayCostUsd: 0,
  agentDayCostUsd: 0,
  elapsedSec: 0,
  deniedCount: 0,
  repeatKey: null,
  repeatCount: 0,
  intentsCount: 0,
  unknownOutcomeKeys: [],
};
const FLAGS: Flags = { killSwitchEngaged: false, taskStatus: "running" };
const cmd = (command: string, commandOperation?: Subject["commandOperation"]): Subject => ({
  kind: "tool_call",
  actionType: "run_command",
  args: { command },
  paths: [],
  origin: "agent",
  ...(commandOperation === undefined ? {} : { commandOperation }),
});
const withRunShell = (p: EffectivePolicy, level: EffectivePolicy["autonomy"]["run_shell"] | undefined): EffectivePolicy => {
  const autonomy = { ...p.autonomy } as Record<string, unknown>;
  if (level === undefined) delete autonomy.run_shell;
  else autonomy.run_shell = level;
  return { ...p, autonomy: autonomy as EffectivePolicy["autonomy"] };
};

describe("run_shell の Hard Ceiling と既定（SG-07）", () => {
  it("書ける値は approve・deny だけ（auto は書けない）。既定は deny", () => {
    expect(writableAutonomy("run_shell", DEFAULT_CEILINGS)).toEqual(["approve", "deny"]);
    expect(CATALOG_DEFAULT_AUTONOMY.run_shell).toBe("deny");
    // auto は approve に切り詰める（mcp_write と同じ）。handoff は書けないので deny
    expect(clampAutonomyToCeiling("auto", "run_shell", DEFAULT_CEILINGS)).toBe("approve");
    expect(clampAutonomyToCeiling("approve", "run_shell", DEFAULT_CEILINGS)).toBe("approve");
    expect(clampAutonomyToCeiling("handoff", "run_shell", DEFAULT_CEILINGS)).toBe("deny");
    expect(clampAutonomyToCeiling("bogus", "run_shell", DEFAULT_CEILINGS)).toBe("deny");
    // run_tests は今までどおり auto か deny
    expect(writableAutonomy("run_tests", DEFAULT_CEILINGS)).toEqual(["auto", "deny"]);
  });
  it("ワークスペースのポリシーに run_shell を書ける（省略も可）。知らない値は拒否", () => {
    expect(parseWorkspacePolicy(ws()).autonomy.run_shell).toBeUndefined();
    expect(parseWorkspacePolicy(ws("approve")).autonomy.run_shell).toBe("approve");
    expect(() => parseWorkspacePolicy({ ...ws(), autonomy: { ...ws().autonomy, run_shell: "sometimes" } })).toThrow();
  });
  it("合成：省略は deny。ワークスペースが auto でも approve に切り詰める。定義の auto は Hard Ceiling の違反", () => {
    expect(effOf(coder()).effective.autonomy.run_shell).toBe("deny");
    expect(effOf(coder(), ws("approve")).effective.autonomy.run_shell).toBe("approve");
    expect(effOf(coder(), ws("auto")).effective.autonomy.run_shell).toBe("approve");
    const r = effOf(coder({ run_shell: "auto" }), ws("approve"));
    expect(r.effective.autonomy.run_shell).toBe("approve");
    expect(r.violations).toMatchObject([{ path: "autonomy.run_shell", by: "ceiling", defined: "auto" }]);
    // ワークスペースが deny のとき、定義の approve はワークスペースより緩い（違反、実効は deny）
    const p = effOf(coder({ run_shell: "approve" }));
    expect(p.effective.autonomy.run_shell).toBe("deny");
    expect(p.violations).toMatchObject([{ path: "autonomy.run_shell", by: "policy" }]);
  });
});

describe("run_shell の分類（classify。SG-07）", () => {
  it("approve → auto は widen にならない（実効は approve のまま。Hard Ceiling の違反として出る）", () => {
    const r = classify({ before: coder({ run_shell: "approve" }), after: coder({ run_shell: "auto" }), ctx: ctxOf(ws("approve")) });
    expect(r.classification).not.toBe("widen");
    expect(r.widenItems).toEqual([]);
    expect(r.items).toEqual([]);
    expect(r.violations).toMatchObject([{ path: "autonomy.run_shell", by: "ceiling" }]);
  });
  it("deny → approve は widen／autonomy_loosened。approve → deny は narrow", () => {
    const loosen = classify({ before: coder({ run_shell: "deny" }), after: coder(), ctx: ctxOf(ws("approve")) });
    expect(loosen.classification).toBe("widen");
    expect(loosen.widenItems).toEqual([{ kind: "autonomy_loosened", class: "widen", path: "autonomy.run_shell", before: "deny", after: "approve" }]);
    const tighten = classify({ before: coder(), after: coder({ run_shell: "deny" }), ctx: ctxOf(ws("approve")) });
    expect(tighten.classification).toBe("narrow");
    expect(tighten.items).toEqual([{ kind: "autonomy_tightened", class: "narrow", path: "autonomy.run_shell", before: "approve", after: "deny" }]);
  });
});

describe("既存の定義・保存した実効ポリシーとの互換（SG-07）", () => {
  it("run_shell を書いていない定義（run_tests を書いたものも）はそのまま検証を通り、run_shell は既定の deny になる", () => {
    const old = coder({ run_tests: "auto", edit_code: "auto" });
    const v = validateAgentDefinition(old);
    expect(v.ok).toBe(true);
    const r = effOf(old);
    expect(r.violations).toEqual([]);
    expect(r.effective.autonomy).toMatchObject({ run_tests: "auto", edit_code: "auto", run_shell: "deny" });
  });
  it("定義に run_shell を書ける（approve・deny）。知らない値はスキーマが拒否", () => {
    expect(validateAgentDefinition(coder({ run_shell: "deny" })).ok).toBe(true);
    expect(validateAgentDefinition(coder({ run_shell: "approve" })).ok).toBe(true);
    expect(validateAgentDefinition(coder({ run_shell: "sometimes" as never })).ok).toBe(false);
  });
  it("run_shell のキーがない古い実効ポリシー（SG-07 の前に作ったスナップショット）でも、許可リストの形は run_tests で今までどおり、それ以外は deny", () => {
    const current = effOf(coder()).effective;
    const old = withRunShell(current, undefined);
    expect(Object.hasOwn(old.autonomy, "run_shell")).toBe(false);
    expect(decide(old, cmd("npm test"), COUNTERS, FLAGS, EMPTY_TAINT)).toMatchObject({ decision: "allow", operation: "run_tests" });
    expect(decide(old, cmd("curl https://example.com"), COUNTERS, FLAGS, EMPTY_TAINT)).toMatchObject({
      decision: "deny",
      reasonCode: "autonomy_deny",
      matchedRule: "autonomy.run_shell",
      operation: "run_shell",
    });
  });
});

describe("decide と run_shell（SG-07）", () => {
  const P = effOf(coder()).effective;
  it("dev-coder の実効ポリシー：許可リストの形は allow（run_tests）、それ以外は deny（run_shell）", () => {
    expect(P.tools).toContain("run_command");
    expect(decide(P, cmd("npm test"), COUNTERS, FLAGS, EMPTY_TAINT)).toMatchObject({ decision: "allow", reasonCode: "autonomy_auto", operation: "run_tests" });
    expect(decide(P, cmd("npm test; curl x"), COUNTERS, FLAGS, EMPTY_TAINT)).toMatchObject({ decision: "deny", reasonCode: "autonomy_deny", operation: "run_shell" });
  });
  it("edge が汚染で run_shell にしたものは、形が許可リストでも deny（汚染そのものは decide の条件に出てこない）", () => {
    expect(decide(P, cmd("npm test", "run_shell"), COUNTERS, FLAGS, EMPTY_TAINT)).toMatchObject({ decision: "deny", operation: "run_shell" });
    // 逆に汚染した TaintState を渡しても、commandOperation がなければ decide は形だけで決める（BR-39：汚染は手順の条件に出ない）
    const tainted: TaintState = { tainted: true, sources: [{ kind: "web_fetch", url: "https://example.com/", at: AT }] };
    expect(decide(P, cmd("npm test"), COUNTERS, FLAGS, tainted)).toMatchObject({ decision: "allow", operation: "run_tests" });
    // 写し先は inputsHash に入る（同じコマンドでも写し先が違えば別の入力）
    const a = decide(P, cmd("npm test", "run_tests"), COUNTERS, FLAGS, EMPTY_TAINT);
    const b = decide(P, cmd("npm test", "run_shell"), COUNTERS, FLAGS, EMPTY_TAINT);
    expect(a.inputsHash).not.toBe(b.inputsHash);
    // 欠けたときと run_tests を明示したとき（どちらも run_tests）は別の入力として記録される（undefined は正規形に入らない）
    expect(decide(P, cmd("npm test"), COUNTERS, FLAGS, EMPTY_TAINT).inputsHash).not.toBe(a.inputsHash);
  });
  it("run_shell が approve なら approve（approval_required）。auto と書かれていても decide の中で approve（Hard Ceiling：KD §8-27）", () => {
    const approve = withRunShell(P, "approve");
    expect(decide(approve, cmd("curl x"), COUNTERS, FLAGS, EMPTY_TAINT)).toMatchObject({ decision: "approve", reasonCode: "approval_required", matchedRule: "autonomy.run_shell" });
    const auto = withRunShell(P, "auto");
    const r = decide(auto, cmd("curl x"), COUNTERS, FLAGS, EMPTY_TAINT);
    expect(r.decision).toBe("approve");
    expect(r.reasonCode).not.toBe("autonomy_auto");
    const handoff = withRunShell(P, "handoff");
    expect(decide(handoff, cmd("curl x"), COUNTERS, FLAGS, EMPTY_TAINT).decision).toBe("handoff");
  });
  it("run_shell はどの実効ポリシーでも allow にならない", () => {
    for (const level of ["auto", "approve", "handoff", "deny", undefined, "bogus"] as const) {
      const p = withRunShell(P, level as never);
      for (const s of [cmd("curl x"), cmd("npm test", "run_shell"), cmd("sh -c 'npm test'", "run_tests")]) {
        const r = decide(p, s, COUNTERS, FLAGS, EMPTY_TAINT);
        expect(r.operation).toBe("run_shell");
        expect(r.decision).not.toBe("allow");
      }
    }
  });
});

describe("taintedByOutsideContent（SG-07 の (a) の入力）", () => {
  const sandbox = { kind: "sandbox_run" as const, at: AT };
  const fetch = { kind: "web_fetch" as const, url: "https://example.com/", at: AT };
  it("汚染なしは false、Web・コネクタ・検索を読んだら true", () => {
    expect(taintedByOutsideContent(EMPTY_TAINT)).toBe(false);
    expect(taintedByOutsideContent({ tainted: true, sources: [fetch] })).toBe(true);
    expect(taintedByOutsideContent({ tainted: true, sources: [{ kind: "web_search", at: AT }] })).toBe(true);
    expect(
      taintedByOutsideContent({
        tainted: true,
        sources: [{ kind: "mcp_read", connectorId: "c", connectorSlug: "mail", connectorName: "メール", tool: "list_inbox", at: AT }],
      }),
    ).toBe(true);
  });
  it("作業場で自分が動かしたコマンドの出力（sandbox_run）だけなら false（作る→動かす→直すを続けられる）", () => {
    expect(taintedByOutsideContent({ tainted: true, sources: [sandbox] })).toBe(false);
    expect(taintedByOutsideContent({ tainted: true, sources: [sandbox, fetch] })).toBe(true);
  });
  it("受け渡し・連絡は upstream が sandbox_run だけなら false。外の内容を含む・空なら true", () => {
    const handoff = (upstream: DirectTaintSource[]) =>
      ({ tainted: true, sources: [{ kind: "handoff", fromTaskId: "t", fromAgentName: "作る係", upstream, at: AT }] }) as TaintState;
    expect(taintedByOutsideContent(handoff([sandbox]))).toBe(false);
    expect(taintedByOutsideContent(handoff([sandbox, fetch]))).toBe(true);
    expect(taintedByOutsideContent(handoff([]))).toBe(true);
    const msg = (upstream: DirectTaintSource[]) =>
      ({ tainted: true, sources: [{ kind: "team_message", messageId: "m", fromTaskId: "t", fromAgentName: "調べ係", upstream, at: AT }] }) as TaintState;
    expect(taintedByOutsideContent(msg([sandbox]))).toBe(false);
    expect(taintedByOutsideContent(msg([fetch]))).toBe(true);
  });
  it("食い違い（tainted なのに sources が空・配列でない）と知らない種類は true（厳しい側）", () => {
    expect(taintedByOutsideContent({ tainted: true, sources: [] })).toBe(true);
    expect(taintedByOutsideContent({ tainted: true, sources: null as never })).toBe(true);
    expect(taintedByOutsideContent({ tainted: false, sources: [{ kind: "future_kind", at: AT } as never] })).toBe(true);
  });
  it("operationOfCommand と合わせると：外の内容のあとの npm test は run_shell、自分のコマンドの出力のあとは run_tests", () => {
    expect(operationOfCommand("npm test", taintedByOutsideContent({ tainted: true, sources: [fetch] }))).toBe("run_shell");
    expect(operationOfCommand("npm test", taintedByOutsideContent({ tainted: true, sources: [sandbox] }))).toBe("run_tests");
  });
});

describe("taintedByOutsideContent と作業場の控え（workspace_snapshot：SG-05 と合わせた監査の直し）", () => {
  const sandbox: DirectTaintSource = { kind: "sandbox_run", at: AT };
  const fetch: DirectTaintSource = { kind: "web_fetch", url: "https://example.com/inject", at: AT };
  const snap = (taint: TaintState, fromTaskId = "t-1") => taintOnWorkspaceSnapshot(EMPTY_TAINT, { snapshotId: "s-1", fromTaskId, taint }, "t-2", AT);

  it("Web を読んだタスクの控えを受け取ったタスクは外の内容として数える（控えで洗い流さない）", () => {
    const received = snap({ tainted: true, sources: [fetch, sandbox] });
    expect(received.sources).toMatchObject([{ kind: "workspace_snapshot", upstream: [{ kind: "web_fetch" }, { kind: "sandbox_run" }] }]);
    expect(taintedByOutsideContent(received)).toBe(true);
    expect(operationOfCommand("npm test", taintedByOutsideContent(received))).toBe("run_shell");
  });
  it("作業場の中の出力（sandbox_run）だけの控えは数えない（作る → 動かす → 直すを次のタスクでも続けられる）。鎖になっても同じ", () => {
    const t2 = snap({ tainted: true, sources: [sandbox] });
    expect(taintedByOutsideContent(t2)).toBe(false);
    // タスク2 がコマンドを動かして控えを残し、タスク3 が受け取る
    const t2After = addTaintSource(t2, sandbox);
    const t3 = taintOnWorkspaceSnapshot(EMPTY_TAINT, { snapshotId: "s-2", fromTaskId: "t-2", taint: t2After }, "t-3", AT);
    expect(taintedByOutsideContent(t3)).toBe(false);
    // 鎖の途中で Web を読めば、その先はずっと数える
    const t3Web = addTaintSource(t3, fetch);
    const t4 = taintOnWorkspaceSnapshot(EMPTY_TAINT, { snapshotId: "s-3", fromTaskId: "t-3", taint: t3Web }, "t-4", AT);
    expect(taintedByOutsideContent(t4)).toBe(true);
  });
  it("外の内容を含む受け渡しを経た控え・スキル・元の分からない控え（0013 で印を付けた古い控え：upstream が空）は数える", () => {
    const viaHandoff = snap({ tainted: true, sources: [{ kind: "handoff", fromTaskId: "t-0", fromAgentName: "調べ係", upstream: [fetch], at: AT }] });
    expect(taintedByOutsideContent(viaHandoff)).toBe(true);
    expect(taintedByOutsideContent(snap({ tainted: true, sources: [{ kind: "skill", name: "x", packId: null, at: AT }] }))).toBe(true);
    const legacy: TaintState = { tainted: true, sources: [{ kind: "workspace_snapshot", snapshotId: "s-0", fromTaskId: "t-0", upstream: [], at: AT }] };
    expect(taintedByOutsideContent(legacy)).toBe(true);
    // 知らない種類が upstream にあれば数える
    expect(taintedByOutsideContent(snap({ tainted: true, sources: [{ kind: "future" } as never] }))).toBe(true);
  });
  it("出どころが上限（TAINT_SOURCES_MAX）に達していたら、新しい出どころが捨てられたかもしれないので数える", () => {
    // 外の内容でない出どころ（sandbox_run だけの受け渡し）で上限まで埋める
    let state: TaintState = EMPTY_TAINT;
    for (let i = 0; state.sources.length < TAINT_SOURCES_MAX; i += 1) {
      state = addTaintSource(state, { kind: "handoff", fromTaskId: `t-${i}`, fromAgentName: "作る係", upstream: [sandbox], at: AT });
    }
    // 上限の手前（49件）なら数えない
    const below: TaintState = { tainted: true, sources: state.sources.slice(0, TAINT_SOURCES_MAX - 1) };
    expect(taintedByOutsideContent(below)).toBe(false);
    // Web を読んでも上限で捨てられる（addTaintSource は古い順に残す）
    const afterFetch = addTaintSource(state, fetch);
    expect(afterFetch.sources.some((s) => s.kind === "web_fetch")).toBe(false);
    expect(taintedByOutsideContent(afterFetch)).toBe(true);
    // upstream が上限に達している受け渡しも数える
    const fullUpstream = Array.from({ length: TAINT_SOURCES_MAX }, () => sandbox);
    expect(taintedByOutsideContent({ tainted: true, sources: [{ kind: "handoff", fromTaskId: "t", fromAgentName: "a", upstream: fullUpstream, at: AT }] })).toBe(true);
  });
});

describe("run_shell の deny は denied_attempts_max に数えない（SG-07 監査の直し）", () => {
  const P = effOf(coder()).effective;
  it("ls → cat → pip install（run_shell・deny）の3回のあとでも、次の npm test は halt にならず allow", () => {
    let c = COUNTERS;
    for (const command of ["ls", "cat /etc/passwd", "pip install requests"]) {
      const s = cmd(command);
      const r = decide(P, s, c, FLAGS, EMPTY_TAINT);
      expect(r).toMatchObject({ decision: "deny", reasonCode: "autonomy_deny", operation: "run_shell" });
      c = nextCounters(c, s, r, false);
    }
    expect(c.deniedCount).toBe(0);
    expect(P.breakers.denied_attempts_max).toBe(3);
    expect(decide(P, cmd("npm test"), c, FLAGS, EMPTY_TAINT)).toMatchObject({ decision: "allow", operation: "run_tests" });
  });
  it("汚染で run_shell にしたもの（commandOperation）も数えない。数えるかどうかは操作と理由だけで決める（汚染の値は見ない）", () => {
    const s = cmd("npm test", "run_shell");
    const tainted: TaintState = { tainted: true, sources: [{ kind: "web_fetch", url: "https://example.com/", at: AT }] };
    const r1 = decide(P, s, COUNTERS, FLAGS, EMPTY_TAINT);
    const r2 = decide(P, s, COUNTERS, FLAGS, tainted);
    expect(nextCounters(COUNTERS, s, r1, false).deniedCount).toBe(0);
    expect(nextCounters(COUNTERS, s, r2, false).deniedCount).toBe(0);
  });
  it("ほかの deny（run_command を渡していない not_granted・別の操作の autonomy_deny）は今までどおり数える", () => {
    const noTools: EffectivePolicy = { ...P, tools: P.tools.filter((t) => t !== "run_command") };
    const s = cmd("curl x");
    const r = decide(noTools, s, COUNTERS, FLAGS, EMPTY_TAINT);
    expect(r).toMatchObject({ decision: "deny", reasonCode: "not_granted" });
    expect(nextCounters(COUNTERS, s, r, false).deniedCount).toBe(1);
    const denyTests = { ...P, autonomy: { ...P.autonomy, run_tests: "deny" as const } };
    const r2 = decide(denyTests, cmd("npm test"), COUNTERS, FLAGS, EMPTY_TAINT);
    expect(r2).toMatchObject({ decision: "deny", operation: "run_tests" });
    expect(nextCounters(COUNTERS, cmd("npm test"), r2, false).deniedCount).toBe(1);
  });
  it("同じ run_shell の呼び出しの繰り返しは same_action_repeat で止まる", () => {
    let c = COUNTERS;
    const s = cmd("ls");
    let last = decide(P, s, c, FLAGS, EMPTY_TAINT);
    for (let i = 0; i < 10 && last.decision !== "halt"; i += 1) {
      c = nextCounters(c, s, last, false);
      last = decide(P, s, c, FLAGS, EMPTY_TAINT);
    }
    expect(last).toMatchObject({ decision: "halt", reasonCode: "breaker_tripped", matchedRule: "breakers.same_action_repeat" });
  });
});
