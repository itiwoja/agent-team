import type { ChatMessage } from "@open-team/runner";
import { toGeminiFunctionCall, type McpFunctionTable } from "./tools.ts";
import { LlmError } from "./types.ts";

type Obj = Record<string, unknown>;

/** 呼び出し ID の重複と、ツール結果の過不足を送信前に検証する。 */
export function validateHistory(messages: readonly ChatMessage[]): void {
  const seen = new Set<string>();
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") {
      if (!pending.delete(message.content.toolCallId)) {
        throw new LlmError("ツール結果に対応する呼び出しがありません", null, false);
      }
      continue;
    }
    if (pending.size) throw new LlmError("ツール結果が不足しています", null, false);
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type !== "tool_call") continue;
      if (!part.id || seen.has(part.id)) throw new LlmError("ツール呼び出しIDが重複しています", null, false);
      seen.add(part.id);
      pending.add(part.id);
    }
  }
  if (pending.size) throw new LlmError("ツール結果が不足しています", null, false);
}

export function openAiMessages(messages: readonly ChatMessage[], table: McpFunctionTable): Obj[] {
  return messages.map(message => {
    if (message.role === "user") return { role: "user", content: message.content };
    if (message.role === "tool") {
      return { role: "tool", tool_call_id: message.content.toolCallId, content: message.content.result };
    }
    const calls = message.content.filter(part => part.type === "tool_call").map(part => {
      const call = toGeminiFunctionCall(part, table);
      return { id: part.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } };
    });
    return {
      role: "assistant",
      content: message.content.filter(part => part.type === "text").map(part => part.text).join("\n") || null,
      ...(calls.length ? { tool_calls: calls } : {}),
    };
  });
}

/** Anthropic ではツール結果を user に変換し、連続する同じ役割をまとめる。 */
export function anthropicMessages(messages: readonly ChatMessage[], table: McpFunctionTable): Obj[] {
  const out: Array<{ role: string; content: Obj[] }> = [];
  for (const message of messages) {
    const role = message.role === "assistant" ? "assistant" : "user";
    let content: Obj[];
    if (message.role === "user") {
      content = [{ type: "text", text: message.content }];
    } else if (message.role === "tool") {
      content = [{ type: "tool_result", tool_use_id: message.content.toolCallId, content: message.content.result }];
    } else {
      content = message.content.map(part => {
        if (part.type === "text") return { type: "text", text: part.text };
        const call = toGeminiFunctionCall(part, table);
        return { type: "tool_use", id: part.id, name: call.name, input: call.args };
      });
    }
    const previous = out.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else out.push({ role, content });
  }
  return out;
}
