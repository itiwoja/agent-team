// runner から来る値の検証（packages/edge/src/validate.ts の写し。Zod v4。runner は信用しない前提：ADR-003）。外れたら 400 VALIDATION_ERROR（formation-runtime.md §3.10-2）
// LLM の応答（LLM が書いたもの）の中身の形は、判定と実行の所でそれぞれ確かめる（ここでは会話の形だけ）

import { z } from "zod";
import { EdgeError, type ChatMessage, type LlmMessagesRequest, type LlmPhase, type ProgressEvent, type ReportSource } from "@open-team/runner";
import { zodIssuesToDetails } from "@open-team/platform";
import type { EdgeLimits } from "./limits.ts";
import { charCount, jsonBytes } from "./util.ts";

/** LLM Proxy の phase（runner の LlmPhase。design は受け付けない：si:101、HL-23） */
export const LLM_PHASES = ["investigate", "plan", "implement", "review", "report"] as const satisfies readonly LlmPhase[];

const TextPartSchema = z.strictObject({ type: z.literal("text"), text: z.string(), signature: z.string().optional() });
const ToolCallPartSchema = z.strictObject({
  type: z.literal("tool_call"),
  id: z.string().min(1).max(200),
  name: z.string().max(200),
  arguments: z.unknown(),
  signature: z.string().optional(),
});
const ChatMessageSchema = z.discriminatedUnion("role", [
  z.strictObject({ role: z.literal("user"), content: z.string() }),
  z.strictObject({ role: z.literal("assistant"), content: z.array(z.discriminatedUnion("type", [TextPartSchema, ToolCallPartSchema])) }),
  z.strictObject({ role: z.literal("tool"), content: z.strictObject({ toolCallId: z.string(), name: z.string(), result: z.string() }) }),
]);
/** ツールは名前だけを使う（宣言の中身は edge が作ったものを LLM に渡す） */
const ToolSpecSchema = z.object({ name: z.string().min(1).max(64), description: z.string(), inputSchema: z.unknown() });

function validationError(error: z.ZodError, extra: Record<string, unknown> = {}): EdgeError {
  return new EdgeError("VALIDATION_ERROR", { issues: zodIssuesToDetails(error.issues), ...extra });
}

/** API-037 の本文（formation-runtime.md §3.10-2）。system と messages の合計は 1MB まで、maxTokens は 1〜16,000 */
export function parseLlmMessagesRequest(raw: unknown, limits: Pick<EdgeLimits, "messagesMaxBytes" | "maxTokensMin" | "maxTokensMax">): LlmMessagesRequest {
  const schema = z.strictObject({
    phase: z.enum(LLM_PHASES),
    system: z.string(),
    messages: z.array(ChatMessageSchema).min(1),
    tools: z.array(ToolSpecSchema),
    maxTokens: z.int().min(limits.maxTokensMin).max(limits.maxTokensMax),
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw validationError(parsed.error);
  const req = parsed.data;
  if (jsonBytes({ system: req.system, messages: req.messages }) > limits.messagesMaxBytes) {
    throw new EdgeError("VALIDATION_ERROR", { reason: "messages_too_large", maxBytes: limits.messagesMaxBytes });
  }
  // 同じ名前のツールは1つにする
  const seen = new Set<string>();
  const tools = req.tools.filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true)));
  return {
    phase: req.phase,
    system: req.system,
    messages: req.messages as ChatMessage[],
    tools: tools.map((t) => ({ name: t.name as LlmMessagesRequest["tools"][number]["name"], description: t.description, inputSchema: t.inputSchema })),
    maxTokens: req.maxTokens,
  };
}

const EventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("phase_started"), payload: z.strictObject({ phase: z.string() }) }),
  z.strictObject({
    type: z.literal("tool_called"),
    payload: z.strictObject({ toolCallId: z.string(), name: z.string(), resultSummary: z.string() }),
  }),
  z.strictObject({ type: z.literal("message"), payload: z.strictObject({ text: z.string() }) }),
  z.strictObject({ type: z.literal("finished"), payload: z.strictObject({ outcome: z.enum(["no_change", "unable"]), reason: z.string() }) }),
]);
/** 1回の上限は20件（超えた分は dropped：HL-24）。それよりずっと多い要求は形の誤りとして落とす */
const EVENTS_HARD_MAX = 1000;

/** API-038 の本文（si:133）。形が違えば 400 */
export function parseProgressEvents(raw: unknown): ProgressEvent[] {
  const parsed = z.array(EventSchema).max(EVENTS_HARD_MAX).safeParse(raw);
  if (!parsed.success) throw validationError(parsed.error);
  return parsed.data as ProgressEvent[];
}

/** submit_report の引数（formation-runtime.md §3.12-1：title 1〜256文字、body 50,000文字まで、sources は配列。文字数はコードポイント） */
export interface ReportArgs {
  title: string;
  body: string;
  sources: ReportSource[];
  /** 次の手の提案（空・長すぎるものは捨てる）。なければ空 */
  nextActions: string[];
  /** 見張りの「前回から変化があったか」。言わなければ undefined */
  changed?: boolean;
}

/** 次の手の提案の上限（数・1つの文字数） */
export const NEXT_ACTIONS_MAX = 3;
export const NEXT_ACTION_MAX_CHARS = 80;

/** 次の手の提案を整える。報告そのものは止めない（形の崩れた提案は捨てる） */
export function normalizeNextActions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const t = v.replace(/\s+/g, " ").trim();
    if (t === "" || charCount(t) > NEXT_ACTION_MAX_CHARS || out.includes(t)) continue;
    out.push(t);
    if (out.length >= NEXT_ACTIONS_MAX) break;
  }
  return out;
}

const SourceSchema = z.looseObject({ kind: z.enum(["url", "mcp", "agent"]) });

/**
 * 出典（BR-45。runner の ReportSource）。宣言は kind で分けた1つのオブジェクトなので、kind に要る項目だけを取り出す
 * （url：url、mcp：connector・tool、agent：agentName。ほかの項目は捨てる）。要る項目がなければ null
 */
function sourceOf(raw: Record<string, unknown>): ReportSource | null {
  const str = (k: string): string | undefined => (typeof raw[k] === "string" && (raw[k] as string).trim() !== "" ? (raw[k] as string) : undefined);
  switch (raw.kind) {
    case "url": {
      const url = str("url");
      if (url === undefined) return null;
      const title = str("title");
      return { kind: "url", url, ...(title !== undefined ? { title } : {}) };
    }
    case "mcp": {
      const connector = str("connector");
      const tool = str("tool");
      if (connector === undefined || tool === undefined) return null;
      const label = str("label");
      return { kind: "mcp", connector, tool, ...(label !== undefined ? { label } : {}) };
    }
    case "agent": {
      const agentName = str("agentName");
      return agentName === undefined ? null : { kind: "agent", agentName };
    }
    default:
      return null;
  }
}

export function parseReportArgs(raw: unknown, limits: Pick<EdgeLimits, "reportTitleMax" | "reportBodyMax">): ReportArgs {
  const schema = z.object({
    title: z.string().refine((s) => s.trim().length > 0 && charCount(s) <= limits.reportTitleMax, { message: `title は1〜${limits.reportTitleMax}文字` }),
    body: z.string().refine((s) => charCount(s) <= limits.reportBodyMax, { message: `body は${limits.reportBodyMax}文字まで` }),
    sources: z.array(SourceSchema).max(100),
    // 窓口かどうかは edge が ask_members で決め、この値は使わない（§8-13）
    kind: z.literal("answer").optional(),
    summary: z.string().optional(),
    next_actions: z.unknown().optional(),
    changed: z.boolean().optional(),
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw validationError(parsed.error);
  const sources: ReportSource[] = [];
  for (const [i, s] of parsed.data.sources.entries()) {
    const src = sourceOf(s);
    if (src === null) throw new EdgeError("VALIDATION_ERROR", { issues: [{ field: `sources[${i}]`, reason: "出典の kind に要る項目がありません" }] });
    sources.push(src);
  }
  return {
    title: parsed.data.title,
    body: parsed.data.body,
    sources,
    nextActions: normalizeNextActions(parsed.data.next_actions),
    ...(parsed.data.changed === undefined ? {} : { changed: parsed.data.changed }),
  };
}

/** notify の引数（cat:86）。長すぎる文は上限で切る（通知は短い知らせ。止めるほどの誤りではない） */
export function parseNotifyArgs(raw: unknown): { title: string; body: string; priority: "normal" | "high" } | null {
  const parsed = z
    .object({ title: z.string().min(1), body: z.string().min(1), priority: z.string().optional() })
    .safeParse(raw);
  if (!parsed.success) return null;
  return { title: parsed.data.title, body: parsed.data.body, priority: parsed.data.priority === "high" ? "high" : "normal" };
}
