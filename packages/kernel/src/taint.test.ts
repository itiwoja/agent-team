import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decide } from "./decide.ts";
import {
  TAINT_SOURCES_MAX,
  addTaintSource,
  answerTaintLine,
  flattenDirectSources,
  handoffMark,
  isTainted,
  requiresConfirmationCard,
  taintFromInputs,
  taintOnTeamMessage,
  taintOnWorkspaceSnapshot,
  taintReasonLine,
  taintSourceList,
} from "./taint.ts";
import { EMPTY_TAINT, OPERATION_TYPES } from "./types.ts";
import type {
  AutonomyLevel,
  Counters,
  DirectTaintSource,
  EffectivePolicy,
  Flags,
  JsonObject,
  OperationType,
  Subject,
  TaintSource,
  TaintState,
  ToolHash,
  ToolInfo,
} from "./types.ts";

// ---- フィクスチャ（MT §2.7 の形。仕入れ係の例） ----
const AT = "2026-10-03T09:00:00.000Z";
const NOW = "2026-10-03T09:30:00.000Z";
const MAIL: DirectTaintSource = { kind: "mcp_read", connectorId: "c-mail", connectorSlug: "mail", connectorName: "メール", tool: "list_inbox", at: AT };
const STORE: DirectTaintSource = {
  kind: "mcp_read",
  connectorId: "c-store",
  connectorSlug: "store",
  connectorName: "店舗の在庫",
  tool: "get_inventory",
  at: AT,
};
const WEB: DirectTaintSource = { kind: "web_fetch", url: "https://example.com/news?id=1", at: AT };
const SEARCH: DirectTaintSource = { kind: "web_search", at: AT };
const read = (...sources: TaintSource[]): TaintState => sources.reduce<TaintState>((s, src) => addTaintSource(s, src), EMPTY_TAINT);
const handoffFrom = (state: TaintState, taskId = "t-inbox", agentName = "受信箱係") => taintFromInputs([{ taskId, agentName, taint: state }], NOW);
const message = (over: Partial<{ messageId: string; fromTaskId: string; fromAgentName: string; tainted: boolean; upstream: DirectTaintSource[] }> = {}) => ({
  messageId: "m-1",
  fromTaskId: "t-inbox",
  fromAgentName: "受信箱係",
  tainted: true,
  upstream: [MAIL],
  ...over,
});
const mcpSource = (k: number): DirectTaintSource => ({
  kind: "mcp_read",
  connectorId: `c-${k}`,
  connectorSlug: `s${k}`,
  connectorName: `コネクタ${k}`,
  tool: "read",
  at: AT,
});

describe("汚染の遷移（MT §3.9、BR-38）", () => {
  it("TA-01：新しいタスクは tainted = false・sources = []", () => {
    expect(EMPTY_TAINT).toEqual({ tainted: false, sources: [] });
    expect(isTainted(EMPTY_TAINT)).toBe(false);
  });

  it("TA-02：mail.list_inbox の結果を受け取ると tainted・sources = [mcp_read(mail, list_inbox)]。元の状態は変えない", () => {
    const before = { tainted: false, sources: [] } as TaintState;
    const after = addTaintSource(before, MAIL);
    expect(after).toEqual({ tainted: true, sources: [MAIL] });
    expect(before).toEqual({ tainted: false, sources: [] });
  });

  it("TA-03：web_search の結果で tainted", () => {
    expect(addTaintSource(EMPTY_TAINT, SEARCH)).toEqual({ tainted: true, sources: [SEARCH] });
  });

  it("TA-04：web_fetch の結果で tainted、sources に URL", () => {
    const s = addTaintSource(EMPTY_TAINT, WEB);
    expect(s.tainted).toBe(true);
    expect(s.sources).toEqual([{ kind: "web_fetch", url: "https://example.com/news?id=1", at: AT }]);
  });

  it("TA-05：本文のない読み取り（store.get_inventory）でも tainted（BR-38 は無条件：MT C-12）", () => {
    expect(addTaintSource(EMPTY_TAINT, STORE).tainted).toBe(true);
  });

  it("TA-18：同じツールを3回読んでも sources は1件（最初のものを残す）", () => {
    const later = { ...MAIL, at: "2026-10-03T10:00:00.000Z" };
    const s = read(MAIL, later, { ...MAIL, at: "2026-10-03T11:00:00.000Z" });
    expect(s.sources).toEqual([MAIL]);
  });

  it("重複の鍵：mcp_read は (connectorId, tool)、web_fetch は url、web_search は1件", () => {
    const otherTool: DirectTaintSource = { ...MAIL, tool: "read_message" };
    const sameConnectorOtherName: DirectTaintSource = { ...MAIL, connectorName: "別名" };
    expect(read(MAIL, otherTool, sameConnectorOtherName).sources).toEqual([MAIL, otherTool]);
    expect(read(WEB, { ...WEB, at: NOW }, { kind: "web_fetch", url: "https://example.com/other", at: AT }).sources).toHaveLength(2);
    expect(read(SEARCH, { kind: "web_search", at: NOW }).sources).toEqual([SEARCH]);
  });

  it("重複の鍵：handoff は fromTaskId、team_message は messageId", () => {
    const h1: TaintSource = { kind: "handoff", fromTaskId: "t1", fromAgentName: "A", upstream: [MAIL], at: AT };
    const h1again: TaintSource = { kind: "handoff", fromTaskId: "t1", fromAgentName: "A", upstream: [WEB], at: NOW };
    const m1: TaintSource = { kind: "team_message", messageId: "m1", fromTaskId: "t1", fromAgentName: "A", upstream: [], at: AT };
    const m2: TaintSource = { ...m1, messageId: "m2" };
    expect(read(h1, h1again, m1, m1, m2).sources).toEqual([h1, m1, m2]);
  });

  it("TA-19：60種類の情報源を読んでも sources は50件で止まり（古い順に残す）、tainted のまま", () => {
    const sources = Array.from({ length: 60 }, (_, k) => mcpSource(k));
    const s = read(...sources);
    expect(TAINT_SOURCES_MAX).toBe(50);
    expect(s.tainted).toBe(true);
    expect(s.sources).toEqual(sources.slice(0, 50));
    // 50件のあとに足しても変わらない（tainted は true のまま）
    expect(addTaintSource(s, WEB)).toEqual({ tainted: true, sources: sources.slice(0, 50) });
  });

  it("TA-11（性質）：addTaintSource は単調。tainted は true、前の sources は先頭に残り、重複なしで50件まで", () => {
    const direct = fc.oneof(
      fc.record({ kind: fc.constant("mcp_read" as const), connectorId: fc.constantFrom("c1", "c2", "c3"), connectorSlug: fc.constant("s"), connectorName: fc.string(), tool: fc.constantFrom("a", "b"), at: fc.constant(AT) }),
      fc.record({ kind: fc.constant("web_search" as const), at: fc.constant(AT) }),
      fc.record({ kind: fc.constant("web_fetch" as const), url: fc.webUrl(), at: fc.constant(AT) }),
    );
    const src: fc.Arbitrary<TaintSource> = fc.oneof(
      direct,
      fc.record({ kind: fc.constant("handoff" as const), fromTaskId: fc.constantFrom("t1", "t2"), fromAgentName: fc.string(), upstream: fc.array(direct, { maxLength: 3 }), at: fc.constant(AT) }),
      fc.record({
        kind: fc.constant("team_message" as const),
        messageId: fc.uuid(),
        fromTaskId: fc.constant("t1"),
        fromAgentName: fc.string(),
        upstream: fc.array(direct, { maxLength: 3 }),
        at: fc.constant(AT),
      }),
    );
    fc.assert(
      fc.property(fc.array(src, { minLength: 1, maxLength: 80 }), (list) => {
        let s: TaintState = EMPTY_TAINT;
        for (const x of list) {
          const next = addTaintSource(s, x);
          expect(next.tainted).toBe(true);
          expect(next.sources.slice(0, s.sources.length)).toEqual(s.sources);
          expect(next.sources.length).toBeLessThanOrEqual(TAINT_SOURCES_MAX);
          expect(next.sources.length).toBeGreaterThanOrEqual(s.sources.length);
          s = next;
        }
        expect(isTainted(s)).toBe(true);
      }),
    );
  });
});

describe("受け渡し・連絡での引き継ぎ（MT §3.9、BR-71・BR-75）", () => {
  it("TA-12・CH-02：順番の1段目が tainted なら2段目は tainted で始まり、sources[0] = handoff(受信箱係, upstream=[mcp_read(mail)])", () => {
    const stage2 = handoffFrom(read(MAIL));
    expect(stage2).toEqual({
      tainted: true,
      sources: [{ kind: "handoff", fromTaskId: "t-inbox", fromAgentName: "受信箱係", upstream: [MAIL], at: NOW }],
    });
  });

  it("TA-13・CH-01：1段目が汚染されていなければ2段目も汚染なしで始まる", () => {
    expect(handoffFrom(EMPTY_TAINT)).toEqual({ tainted: false, sources: [] });
    expect(taintFromInputs([], NOW)).toEqual({ tainted: false, sources: [] });
  });

  it("TA-14・PA-06：まとめ3人中1人だけ tainted → まとめ役は tainted、handoff は1件", () => {
    const s = taintFromInputs(
      [
        { taskId: "t1", agentName: "A係", taint: EMPTY_TAINT },
        { taskId: "t2", agentName: "B係", taint: read(WEB) },
        { taskId: "t3", agentName: "C係", taint: EMPTY_TAINT },
      ],
      NOW,
    );
    expect(s.tainted).toBe(true);
    expect(s.sources).toEqual([{ kind: "handoff", fromTaskId: "t2", fromAgentName: "B係", upstream: [WEB], at: NOW }]);
  });

  it("3段の順番：upstream は平らにした直接の情報源だけ（handoff を入れ子にしない）", () => {
    const stage2 = addTaintSource(handoffFrom(read(MAIL)), STORE);
    const stage3 = taintFromInputs([{ taskId: "t-stage2", agentName: "仕入れ係", taint: stage2 }], NOW);
    expect(stage3.sources).toEqual([{ kind: "handoff", fromTaskId: "t-stage2", fromAgentName: "仕入れ係", upstream: [MAIL, STORE], at: NOW }]);
  });

  it("tainted と sources が食い違う入力は汚染として扱う（厳しい側）", () => {
    const odd = { tainted: false, sources: [MAIL] } as TaintState;
    expect(isTainted(odd)).toBe(true);
    expect(handoffFrom(odd).tainted).toBe(true);
  });

  it("flattenDirectSources：handoff・team_message の upstream を展開し、重複を除き、50件まで", () => {
    const state: TaintState = {
      tainted: true,
      sources: [
        MAIL,
        { kind: "handoff", fromTaskId: "t1", fromAgentName: "A", upstream: [MAIL, WEB], at: AT },
        { kind: "team_message", messageId: "m1", fromTaskId: "t2", fromAgentName: "B", upstream: [SEARCH, WEB], at: AT },
      ],
    };
    expect(flattenDirectSources(state)).toEqual([MAIL, WEB, SEARCH]);
    const many: TaintState = {
      tainted: true,
      sources: [{ kind: "handoff", fromTaskId: "t1", fromAgentName: "A", upstream: Array.from({ length: 70 }, (_, k) => mcpSource(k)), at: AT }],
    };
    expect(flattenDirectSources(many)).toHaveLength(50);
    expect(flattenDirectSources(EMPTY_TAINT)).toEqual([]);
  });

  it("TA-15・TB-01：tainted の送り手の連絡を差し込むと、その時点から受け手が tainted（team_message）", () => {
    const s = taintOnTeamMessage(EMPTY_TAINT, message(), NOW);
    expect(s).toEqual({
      tainted: true,
      sources: [{ kind: "team_message", messageId: "m-1", fromTaskId: "t-inbox", fromAgentName: "受信箱係", upstream: [MAIL], at: NOW }],
    });
  });

  it("TA-16：汚染されていない送り手の連絡では受け手は変わらない（同じ値を返す）", () => {
    const before = read(STORE);
    expect(taintOnTeamMessage(before, message({ tainted: false }), NOW)).toBe(before);
    expect(taintOnTeamMessage(EMPTY_TAINT, message({ tainted: false }), NOW)).toBe(EMPTY_TAINT);
  });

  it("TA-17：追いのターンは親の汚染から始まり、質問の送り手の汚染を足す（FR §8-23）", () => {
    const parent = read(MAIL);
    expect(taintOnTeamMessage(parent, message({ tainted: false }), NOW)).toEqual(parent);
    const s = taintOnTeamMessage(parent, message({ messageId: "q-1", fromAgentName: "仕入れ係", upstream: [STORE] }), NOW);
    expect(s.tainted).toBe(true);
    expect(s.sources.map((x) => x.kind)).toEqual(["mcp_read", "team_message"]);
  });

  it("同じ連絡を2回差し込んでも1件", () => {
    const once = taintOnTeamMessage(EMPTY_TAINT, message(), NOW);
    expect(taintOnTeamMessage(once, message(), NOW).sources).toHaveLength(1);
  });
});

describe("作業場の控え・スキルでの持ち越し（SG-05）", () => {
  const RUN: DirectTaintSource = { kind: "sandbox_run", at: AT };
  const SKILL: DirectTaintSource = { kind: "skill", name: "書き換えた手順", packId: "engineer", at: AT };
  const snap = (taint: TaintState, fromTaskId: string | null = "t-prev") => ({ snapshotId: "s-1", fromTaskId, taint });

  it("汚染された控えを受け取ると、受け取ったタスクは workspace_snapshot（upstream は控えの汚染を平らにしたもの）で汚染される", () => {
    const prev = addTaintSource(handoffFrom(read(MAIL)), RUN);
    const s = taintOnWorkspaceSnapshot(EMPTY_TAINT, snap(prev), "t-next", NOW);
    expect(s).toEqual({
      tainted: true,
      sources: [{ kind: "workspace_snapshot", snapshotId: "s-1", fromTaskId: "t-prev", upstream: [MAIL, RUN], at: NOW }],
    });
  });

  it("汚染されていない控え（パックの控え・きれいなタスクの控え）・自分の控えでは状態を変えない（同じ値を返す）", () => {
    const before = read(STORE);
    expect(taintOnWorkspaceSnapshot(before, snap(EMPTY_TAINT, null), "t-next", NOW)).toBe(before);
    expect(taintOnWorkspaceSnapshot(EMPTY_TAINT, snap(EMPTY_TAINT), "t-next", NOW)).toBe(EMPTY_TAINT);
    expect(taintOnWorkspaceSnapshot(before, snap(read(RUN), "t-self"), "t-self", NOW)).toBe(before);
  });

  it("tainted だけ立っていて sources が空の控えも汚染として持ち越す（厳しい側）", () => {
    const s = taintOnWorkspaceSnapshot(EMPTY_TAINT, snap({ tainted: true, sources: [] }), "t-next", NOW);
    expect(s.tainted).toBe(true);
    expect(s.sources).toEqual([{ kind: "workspace_snapshot", snapshotId: "s-1", fromTaskId: "t-prev", upstream: [], at: NOW }]);
  });

  it("控えを持ち越したタスクの受け渡し・次の控えでは、upstream は直接の情報源に平らになる（入れ子にしない）", () => {
    const second = taintOnWorkspaceSnapshot(EMPTY_TAINT, snap(read(RUN, SKILL)), "t-2", NOW);
    expect(flattenDirectSources(second)).toEqual([RUN, SKILL]);
    expect(handoffFrom(second).sources).toEqual([{ kind: "handoff", fromTaskId: "t-inbox", fromAgentName: "受信箱係", upstream: [RUN, SKILL], at: NOW }]);
    const third = taintOnWorkspaceSnapshot(EMPTY_TAINT, { snapshotId: "s-2", fromTaskId: "t-2", taint: second }, "t-3", NOW);
    expect(third.sources).toEqual([{ kind: "workspace_snapshot", snapshotId: "s-2", fromTaskId: "t-2", upstream: [RUN, SKILL], at: NOW }]);
  });

  it("同じタスクの控えを2回受け取っても1件。skill は名前ごとに1件", () => {
    const once = taintOnWorkspaceSnapshot(EMPTY_TAINT, snap(read(RUN)), "t-next", NOW);
    expect(taintOnWorkspaceSnapshot(once, { ...snap(read(RUN)), snapshotId: "s-9" }, "t-next", NOW).sources).toHaveLength(1);
    expect(read(SKILL, SKILL, { ...SKILL, name: "別の手順" }).sources).toHaveLength(2);
  });

  it("表示の文にスキルの名前（DB の値）を入れない", () => {
    const s = read(SKILL);
    expect(taintSourceList(s)).toEqual([{ kind: "skill", label: "運営のパックで確かめられないスキル", detail: "load_skill" }]);
    expect(taintReasonLine(s)).toBe("外から読んだ内容（運営のパックで確かめられないスキル）のあとの送信です");
    expect(JSON.stringify(taintSourceList(s))).not.toContain("書き換えた手順");
    const fromSnap = taintOnWorkspaceSnapshot(EMPTY_TAINT, snap(read(RUN)), "t-next", NOW);
    expect(taintReasonLine(fromSnap)).toBe("前の作業で残ったファイル（作業場で動かしたコマンドの出力）のあとの送信です");
    expect(answerTaintLine(fromSnap)).toBe("外部の内容をもとにしています（前の作業で残ったファイル（作業場で動かしたコマンドの出力））");
  });
});

describe("表示の固定の文（MT §3.15、BR-70・BR-76、FR-063）", () => {
  it("TA-23：汚染されたタスクの書き込みの2行目「外から読んだ内容（メール）のあとの送信です」", () => {
    expect(taintReasonLine(read(MAIL))).toBe("外から読んだ内容（メール）のあとの送信です");
  });

  it("TA-24・U-13：受け渡しで汚染された仕入れ係の書き込み「受信箱係が読んだメールのあとの送信です」", () => {
    expect(taintReasonLine(handoffFrom(read(MAIL)))).toBe("受信箱係が読んだメールのあとの送信です");
  });

  it("TA-25・BR-76：連絡で汚染された書き込み「受信箱係からの連絡のあとの送信です」（受け渡しより連絡を優先）", () => {
    const viaMessage = taintOnTeamMessage(handoffFrom(read(MAIL), "t-x", "調べ係"), message(), NOW);
    expect(taintReasonLine(viaMessage)).toBe("受信箱係からの連絡のあとの送信です（ほか1件）");
    expect(taintReasonLine(taintOnTeamMessage(EMPTY_TAINT, message(), NOW))).toBe("受信箱係からの連絡のあとの送信です");
  });

  it("ラベル：web_fetch は URL のホスト、web_search は「Web 検索」、読めない URL は「Web ページ」", () => {
    expect(taintReasonLine(read(WEB))).toBe("外から読んだ内容（example.com）のあとの送信です");
    expect(taintReasonLine(read(SEARCH))).toBe("外から読んだ内容（Web 検索）のあとの送信です");
    expect(taintReasonLine(read({ kind: "web_fetch", url: "not a url", at: AT }))).toBe("外から読んだ内容（Web ページ）のあとの送信です");
  });

  it("情報源が2つ以上なら末尾に「（ほか{N}件）」。最初に読んだものが主", () => {
    expect(taintReasonLine(read(MAIL, WEB, SEARCH))).toBe("外から読んだ内容（メール）のあとの送信です（ほか2件）");
  });

  it("コネクタの表示名が空なら slug、受け渡しの元が何も読んでいなければ「内容」", () => {
    expect(taintReasonLine(read({ ...MAIL, connectorName: "  " }))).toBe("外から読んだ内容（mail）のあとの送信です");
    const bare: TaintState = { tainted: true, sources: [{ kind: "handoff", fromTaskId: "t1", fromAgentName: "受信箱係", upstream: [], at: AT }] };
    expect(taintReasonLine(bare)).toBe("受信箱係が読んだ内容のあとの送信です");
    expect(taintReasonLine({ tainted: true, sources: [] })).toBe("外から読んだ内容のあとの送信です");
  });

  it("TA-34：差出人名（「店長（確認済み）」）など読んだ中身は文に入らない（ラベルはコネクタの表示名だけ）", () => {
    const line = taintReasonLine(handoffFrom(read(MAIL))) ?? "";
    expect(line).not.toContain("店長");
    expect(line).toContain("メール");
  });

  it("汚染されていなければどの文も出さない", () => {
    expect(taintReasonLine(EMPTY_TAINT)).toBeNull();
    expect(answerTaintLine(EMPTY_TAINT)).toBeNull();
    expect(handoffMark(EMPTY_TAINT)).toBeNull();
    expect(taintSourceList(EMPTY_TAINT)).toEqual([]);
  });

  it("TA-29・AN-05：回答のタスクが tainted なら「外部の内容をもとにしています（受信箱係が読んだメール）」", () => {
    expect(answerTaintLine(handoffFrom(read(MAIL)))).toBe("外部の内容をもとにしています（受信箱係が読んだメール）");
    expect(answerTaintLine(read(MAIL, WEB))).toBe("外部の内容をもとにしています（メール、ほか1件）");
    expect(answerTaintLine({ tainted: true, sources: [] })).toBe("外部の内容をもとにしています");
  });

  it("handoffMark：渡したタスクが tainted なら「外部の内容を含む」（ask-page.md:114）", () => {
    expect(handoffMark(read(MAIL))).toBe("外部の内容を含む");
  });

  it("RU-10・BR-41：送る前の確認の情報源の一覧（ラベルと詳しい値）", () => {
    const s = taintOnTeamMessage(addTaintSource(addTaintSource(handoffFrom(read(MAIL, WEB)), SEARCH), STORE), message({ upstream: [WEB] }), NOW);
    expect(taintSourceList(s)).toEqual([
      { kind: "handoff", label: "受信箱係が読んだメール", detail: "メール、example.com" },
      { kind: "web_search", label: "Web 検索", detail: "web_search" },
      { kind: "mcp_read", label: "店舗の在庫", detail: "store.get_inventory" },
      { kind: "team_message", label: "受信箱係からの連絡", detail: "example.com" },
    ]);
    expect(taintSourceList(read(WEB))).toEqual([{ kind: "web_fetch", label: "example.com", detail: "https://example.com/news?id=1" }]);
  });
});

describe("requiresConfirmationCard（MT §3.16、BR-47・BR-51）", () => {
  it("TA-21：きっかけのタスクが tainted なら neutral でも確認カード（自動で反映しない）", () => {
    expect(requiresConfirmationCard({ classification: "neutral", sourceTaskTainted: true, byUserDirectAction: false })).toBe(true);
  });
  it("TA-22：きっかけのタスクが汚染されていない neutral は自動で反映", () => {
    expect(requiresConfirmationCard({ classification: "neutral", sourceTaskTainted: false, byUserDirectAction: false })).toBe(false);
  });
  it("narrow も汚染されたきっかけなら確認カード（分類に関係なく：BR-51）、汚染なしなら反映", () => {
    expect(requiresConfirmationCard({ classification: "narrow", sourceTaskTainted: true, byUserDirectAction: false })).toBe(true);
    expect(requiresConfirmationCard({ classification: "narrow", sourceTaskTainted: false, byUserDirectAction: false })).toBe(false);
  });
  it("widen は確認カード（BR-47）。ユーザーの直接の操作（[以後も許可] など）は重ねない（BR-47①）", () => {
    expect(requiresConfirmationCard({ classification: "widen", sourceTaskTainted: false, byUserDirectAction: false })).toBe(true);
    expect(requiresConfirmationCard({ classification: "widen", sourceTaskTainted: true, byUserDirectAction: true })).toBe(false);
  });
  it("知らない分類は確認カード（厳しい側）", () => {
    expect(requiresConfirmationCard({ classification: "other" as "widen", sourceTaskTainted: false, byUserDirectAction: false })).toBe(true);
  });
});

describe("BR-39・D-58：汚染は decide() の判定を変えない（RU-09・K-31）", () => {
  const PO = "mcp.supplier.place_order";
  const H: ToolHash = `sha256:${"a".repeat(64)}`;
  const tool: ToolInfo = {
    classification: "write",
    status: "ok",
    connectorEnabled: true,
    scope: null,
    toolHash: H,
    argRoles: { supplier_id: "destination", "items[].sku": "option", "items[].quantity": "option", "items[].unit_price": "option", note: "content" },
  };
  const autonomy = { ...Object.fromEntries(OPERATION_TYPES.map((op) => [op, "deny"])), mcp_read: "auto", mcp_write: "approve" } as Record<
    OperationType,
    AutonomyLevel
  >;
  const policy: EffectivePolicy = {
    version: 1,
    autonomy,
    budget: { per_task_usd: 0.2, per_day_usd: 1, agent_day_usd: null, max_steps: 40, max_minutes: 15 },
    breakers: { same_action_repeat: 5, denied_attempts_max: 3, step_cost_usd_max: 0.5 },
    max_intents_per_task: 5,
    max_runs_per_day: 10,
    tools: ["mcp_call", "notify", "submit_report", "finish"],
    mcp: { llmRead: true, llmWrite: true, deliverWrite: false, grants: { supplier: ["place_order"] } },
    web: { allow_domains: [], deny_domains: [], max_fetches_per_task: 0 },
    rules: {
      enabled: true,
      items: [{ id: "r-1", action: PO, tool_hash: H, match: { supplier_id: "supplier-01", "items[].sku": ["BEAN-HOUSE"] }, free: ["items[].quantity", "items[].unit_price"] }],
    },
    guards: [{ action: PO, arg: "items[].quantity", max: 20, empty: false }],
    approvers: [],
  };
  const counters: Counters = {
    stepsUsed: 1,
    costUsd: 0,
    dayCostUsd: 0,
    agentDayCostUsd: 0,
    elapsedSec: 10,
    deniedCount: 0,
    repeatKey: null,
    repeatCount: 0,
    intentsCount: 0,
    unknownOutcomeKeys: [],
  };
  const flags: Flags = { killSwitchEngaged: false, taskStatus: "running" };
  const subject = (args: JsonObject): Subject => ({ kind: "tool_call", actionType: "mcp_call", action: PO, args, paths: [], tool, origin: "agent" });

  it("どの汚染の状態でも、宛先・数量によらず decision・reasonCode・matchedRule は汚染なしと同じ", () => {
    const states = [read(MAIL), handoffFrom(read(MAIL)), taintOnTeamMessage(EMPTY_TAINT, message(), NOW), read(WEB, SEARCH, STORE)];
    fc.assert(
      fc.property(
        fc.constantFrom("supplier-01", "supplier-99"),
        fc.integer({ min: 1, max: 40 }),
        fc.constantFrom(...states),
        (supplier, quantity, taint) => {
          const s = subject({ supplier_id: supplier, items: [{ sku: "BEAN-HOUSE", quantity, unit_price: 780 }], note: "至急" });
          const clean = decide(policy, s, counters, flags, EMPTY_TAINT);
          const dirty = decide(policy, s, counters, flags, taint);
          expect({ d: dirty.decision, r: dirty.reasonCode, m: dirty.matchedRule }).toEqual({ d: clean.decision, r: clean.reasonCode, m: clean.matchedRule });
        },
      ),
    );
  });

  it("HK-05：受け渡しで汚染されていても、宛先固定・数量は free のルールとガード20以内なら allow、21個なら guard_exceeded", () => {
    const taint = handoffFrom(read(MAIL));
    const ok = decide(policy, subject({ supplier_id: "supplier-01", items: [{ sku: "BEAN-HOUSE", quantity: 20, unit_price: 780 }] }), counters, flags, taint);
    expect([ok.decision, ok.reasonCode]).toEqual(["allow", "rule_matched"]);
    const over = decide(policy, subject({ supplier_id: "supplier-01", items: [{ sku: "BEAN-HOUSE", quantity: 21, unit_price: 780 }] }), counters, flags, taint);
    expect([over.decision, over.reasonCode]).toEqual(["approve", "guard_exceeded"]);
  });
});
