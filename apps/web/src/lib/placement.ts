// SCR-021：やり取り（連絡板）をどの段の後ろに出すか
import type { AskMessageView, StageView } from "../api";

export interface PlacedMessages {
  /** 段の番号（stages の index）の後ろ。ここに入らないものは end */
  after: Map<number, AskMessageView[]>;
  end: AskMessageView[];
}

/** 順番の形は、2者のうち早い段の後ろ（段の間）。並列・まとめは段のあとにまとめて出す */
export function placeMessages(isChain: boolean, stages: readonly StageView[], messages: readonly AskMessageView[]): PlacedMessages {
  const after = new Map<number, AskMessageView[]>();
  const end: AskMessageView[] = [];
  const idx = (name: string | null) => (name === null ? -1 : stages.findIndex((s) => s.agentName === name));
  for (const m of messages) {
    if (!isChain) {
      end.push(m);
      continue;
    }
    const a = idx(m.fromAgentName);
    const b = idx(m.toAgentName);
    const at = [a, b].filter((n) => n >= 0);
    if (at.length === 0) {
      end.push(m);
      continue;
    }
    const i = Math.min(...at);
    after.set(i, [...(after.get(i) ?? []), m]);
  }
  return { after, end };
}

/** 返事（inReplyTo）は元の連絡の下に続ける。親のない返事は単独で出す */
export function threadMessages(messages: readonly AskMessageView[]): Array<{ message: AskMessageView; replies: AskMessageView[] }> {
  const roots = messages.filter((m) => m.inReplyTo === null || !messages.some((x) => x.id === m.inReplyTo));
  return roots.map((message) => ({ message, replies: messages.filter((m) => m.inReplyTo === message.id) }));
}
