import { describe, expect, it } from "vitest";
import { actorLabel, COMMON_EVENT_TYPES, cursorAt, encodeAuditCursor, eventTypeLabel, eventTypeOptions, formatAuditTime, parseSeq, shortHash, summarizeAudit } from "./audit";

const sum = (eventType: string, payload: Record<string, unknown>) => summarizeAudit({ eventType, payload });

describe("カーソル", () => {
  it("API と同じ base64（09 の例 MTAyMzI= ＝ 10232）", () => {
    expect(encodeAuditCursor(10232)).toBe("MTAyMzI=");
  });
  it("seq の行から取るには seq+1 を渡す", () => {
    expect(cursorAt(348)).toBe(encodeAuditCursor(349));
  });
  it("?seq= は正の整数だけ", () => {
    expect(parseSeq("348")).toBe(348);
    expect(parseSeq(null)).toBeNull();
    expect(parseSeq("0")).toBeNull();
    expect(parseSeq("-1")).toBeNull();
    expect(parseSeq("1.5")).toBeNull();
    expect(parseSeq("01")).toBeNull();
  });
});

describe("1行の要約", () => {
  it("decision.made：何をしたか・理由・決まり・操作", () => {
    expect(sum("decision.made", { decision: "deny", reasonCode: "path_denied", matchedRule: "paths.deny[1]", action: "fs.write" })).toBe(
      "止めた · 禁止の場所 · fs.write",
    );
  });
  it("intent.*", () => {
    expect(sum("intent.proposed", { action: "gmail.send", decision: "approve", reasonCode: "approval_required" })).toBe("送る案を作った：gmail.send · 人の確認に回した · 人の確認が必要");
    expect(sum("intent.resolved", { outcome: "executed" })).toBe("届いていたと確かめた");
    expect(sum("intent.expired", { expireReason: "policy_changed" })).toBe("送る案が無効になった · 決まりが変わった");
  });
  it("budget.exceeded：項目ごとの上限と、全体の上限", () => {
    expect(sum("budget.exceeded", { item: "per_task_usd", usedUsd: "0.160000", limitUsd: "0.200000" })).toBe("1件の費用の上限で止めた · $0.16 / $0.20");
    expect(sum("budget.exceeded", { item: "max_steps", used: 30, adding: 1, limit: 30 })).toBe("手数の上限で止めた · 30 / 30");
    expect(sum("budget.exceeded", { scope: "global", limitUsd: "15.000000", spentUsd: "15.010000" })).toBe("全体の1日の上限で止めた · 使った額 $15.01 · 上限 $15.00");
  });
  it("llm.called：モデル・トークン・費用", () => {
    expect(sum("llm.called", { model: "claude-sonnet-5-5", inputTokens: 12000, outputTokens: 900, costUsd: "0.050000" })).toBe("claude-sonnet-5-5 · 12k/900 · $0.05");
  });
  it("task.status_changed", () => {
    expect(sum("task.status_changed", { from: "running", to: "halted" })).toBe("仕事の状態：実行中 → 停止");
  });
  it("知らない種類は主なキーを3つまで（長いハッシュは省く）", () => {
    expect(sum("x.y", { a: 1, hash: "a".repeat(64), b: "foo", c: true, d: "more" })).toBe("a: 1 · b: foo · c: true");
    expect(sum("x.y", { long: "x".repeat(30) })).toBe(`long: ${"x".repeat(24)}…`);
    expect(sum("x.y", {})).toBe("（中身なし）");
  });
  it("足りないキーがあっても落ちない", () => {
    expect(sum("decision.made", {})).toBe("（中身なし）");
    expect(sum("decision.made", { taskId: "t-1", note: "x" })).toBe("note: x");
    expect(sum("budget.exceeded", {})).toBe("上限で止めた");
  });
});

describe("本番の記録の形（2026-10-06 の確認）", () => {
  const id = "0b5c7a52-3c1e-4f0a-9d7e-2a6b1c9e8f01";
  const hash = "9f".repeat(32);
  it("budget.exceeded の scope（spend.ts の global）", () => {
    expect(sum("budget.exceeded", { taskId: id, scope: "global", limitUsd: "15.000000", spentUsd: "14.990000", estimatedUsd: "0.020000" })).toBe(
      "全体の1日の上限で止めた · 使った額 $14.99 · 上限 $15.00",
    );
  });
  it("task.status_changed：実際に出る状態と内訳を全部訳す", () => {
    expect(sum("task.status_changed", { taskId: id, from: "running", to: "completed", detail: "actions_declined" })).toBe("仕事の状態：実行中 → 完了 · 送らないものがあった");
    expect(sum("task.status_changed", { taskId: id, from: "executing", to: "succeeded" })).toBe("仕事の状態：送っている → 成功");
    expect(sum("task.status_changed", { taskId: id, from: "awaiting_approval", to: "failed", failReason: "action_failed" })).toBe("仕事の状態：確認待ち → 失敗 · 送信に失敗した");
    expect(sum("task.status_changed", { taskId: id, from: "running", to: "halted", haltReason: "budget_exceeded", expiredIntents: 0 })).toBe("仕事の状態：実行中 → 停止 · 費用の上限");
    expect(sum("task.status_changed", { taskId: id, from: "queued", to: "provisioning" })).toBe("仕事の状態：待ち → 準備中");
    expect(sum("task.status_changed", { taskId: id, from: "running", to: "rejected" })).toBe("仕事の状態：実行中 → 却下");
  });
  it("action.*：ID・detail を出さない", () => {
    const base = { taskId: id, intentId: id, decision: "approve", reasonCode: "approval_required", presendAttempts: 0 };
    expect(sum("action.unknown_outcome", { ...base, action: "mcp.billing.refund", detail: "socket hang up after send" })).toBe("送ったが届いたかわからない · mcp.billing.refund");
    expect(sum("action.executed", { ...base, action: "mcp.billing.refund", truncated: false })).toBe("送った · mcp.billing.refund");
    expect(sum("action.failed", { ...base, action: "mcp.billing.refund", failReason: "tool_error", isError: true })).toBe("送れなかった · mcp.billing.refund · 道具がエラーを返した");
    // gateway が判定の証拠の照合で止めたとき（SG-03）：理由と、どの証拠が合わなかったか
    expect(sum("action.failed", { ...base, action: "mcp.billing.create_invoice", failReason: "precondition_failed", reasonCode: "approval_provenance", detail: "execution_replayed" })).toBe(
      "送れなかった · mcp.billing.create_invoice · 送る前の前提が崩れた · 判定の証拠が合わなかった · 同じ送る案をもう一度送ろうとした",
    );
    expect(sum("action.started", { ...base, action: "mcp.billing.create_invoice", attempt: 1 })).toBe("送り始めた · mcp.billing.create_invoice");
  });
  it("agent.workspace.reset：作業場を最初に戻した（戻した先・汚染された控えを捨てたか。ID は出さない）", () => {
    expect(eventTypeLabel("agent.workspace.reset")).toBe("作業場を最初に戻す");
    expect(sum("agent.workspace.reset", { agentId: id, name: "採点ロボ先生", previousSnapshotId: id, previousTainted: true, snapshotId: id, origin: "pack", packId: "teacher" })).toBe(
      "作業場を最初に戻した · 採点ロボ先生 · パックのファイルに戻した · 外から来た内容を含む控えを捨てた",
    );
    expect(sum("agent.workspace.reset", { agentId: id, name: "作る係", previousSnapshotId: null, previousTainted: false, snapshotId: id, origin: "empty" })).toBe(
      "作業場を最初に戻した · 作る係 · 空にした",
    );
  });

  it("ask.*：ID の列にしない", () => {
    expect(sum("ask.answered", { askId: id, askRunId: id, answerTaskId: id, bodyHash: hash })).toBe("依頼に答えた");
    expect(sum("ask.step.started", { askId: id, askRunId: id, memberId: id, taskId: id, inputTaskIds: [id], tainted: false })).toBe("担当が仕事を始めた");
    expect(sum("ask.run.started", { askId: id, askRunId: id, runNo: 2, trigger: "manual" })).toBe("依頼を動かした · 手動 · 2回目");
    expect(sum("ask.run.finished", { askId: id, askRunId: id, status: "done" })).toBe("依頼の実行が終わった · 完了");
    expect(sum("ask.message.posted", { askId: id, messageId: id, fromMemberId: id, toMemberId: id, kind: "share", bodyHash: hash, tainted: false })).toBe("チームに伝えた · 共有");
    expect(sum("ask.formed", { askId: id, shape: "chain", plannerAttempts: 1, members: [{ agentId: id }, { agentId: id }], notes: "x" })).toBe("チームを組んだ · 2人 · 順番に");
  });
  it("connector.tool.*：道具の名前だけ", () => {
    expect(sum("connector.tool.added", { connectorId: id, toolId: id, tool: "refund_payment", toolHash: `sha256:${hash}` })).toBe("道具を足した · refund_payment");
    expect(sum("connector.tool.needs_review", { connectorId: id, toolId: id, tool: "refund_payment", action: "mcp.billing.refund_payment", change: "changed", detectedBy: "sync", toolHash: `sha256:${hash}` })).toBe(
      "道具を確認待ちにした · refund_payment · 定義が変わった",
    );
  });
  it("decision.made：決まりの場所（rules.items[0]）を平易にする", () => {
    expect(sum("decision.made", { taskId: id, subjectKind: "tool_call", action: "mcp.billing.refund", decision: "allow", reasonCode: "rule_matched", matchedRule: "rules.items[0]", inputsHash: hash, intentId: id })).toBe(
      "通した · 覚えた決まりに合った · 1番目の決まり · mcp.billing.refund",
    );
    expect(sum("decision.made", { taskId: id, subjectKind: "llm_call", decision: "halt", reasonCode: "budget_exceeded", matchedRule: "budget.per_task_usd" })).toBe(
      "打ち切った · 費用の上限 · AI の呼び出し",
    );
  });
  it("知らない種類でも ID・UUID・ハッシュを出さない", () => {
    expect(sum("x.y", { fooId: "abc", ref: id, toolHash: `sha256:${hash}`, digest: `sha256:${hash}`, name: "foo" })).toBe("name: foo");
  });
});

describe("表示の部品", () => {
  it("実行者：自分は「あなた」", () => {
    expect(actorLabel({ actorType: "user", actorId: "u-1234567890" }, "u-1234567890")).toBe("あなた");
    expect(actorLabel({ actorType: "user", actorId: "u-1234567890" }, "other")).toBe("人（u-123456）");
    expect(actorLabel({ actorType: "agent", actorId: "0123456789abcdef" })).toBe("エージェント（01234567）");
    expect(actorLabel({ actorType: "system", actorId: "edge" })).toBe("仕組み（edge）");
  });
  it("ハッシュの先頭8文字・日時（秒まで）", () => {
    expect(shortHash("0123456789abcdef")).toBe("01234567");
    expect(formatAuditTime(new Date(2026, 9, 6, 12, 7, 3).toISOString())).toBe("2026/10/6 12:07:03");
    expect(formatAuditTime("nope")).toBe("");
  });
  it("種類の候補：主要なものと読み込んだ種類を重ねずに並べる", () => {
    const opts = eventTypeOptions(["agent.created", "decision.made"]);
    expect(opts).toContain("agent.created");
    expect(opts.filter((t) => t === "decision.made")).toHaveLength(1);
    expect([...opts].sort()).toEqual(opts);
  });
});

describe("種類の見出し", () => {
  it("主な種類は日本語の短い名前。知らない種類は event_type のまま", () => {
    expect(eventTypeLabel("budget.exceeded")).toBe("費用の上限");
    expect(eventTypeLabel("decision.made")).toBe("統制の判定");
    expect(eventTypeLabel("agent.config.changed")).toBe("エージェントの設定");
    expect(eventTypeLabel("something.new")).toBe("something.new");
    for (const t of COMMON_EVENT_TYPES) expect(eventTypeLabel(t), t).not.toMatch(/[a-z]/);
  });
});
