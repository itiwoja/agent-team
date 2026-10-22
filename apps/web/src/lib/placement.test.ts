import { describe, expect, it } from "vitest";
import type { AskMessageView, StageView } from "../api";
import { placeMessages, threadMessages } from "./placement";

const st = (agentName: string) => ({ agentName }) as StageView;
const msg = (id: string, from: string, to: string | null, inReplyTo: string | null = null) => ({ id, fromAgentName: from, toAgentName: to, inReplyTo }) as AskMessageView;

describe("やり取りの置き場所", () => {
  const stages = [st("受信箱係"), st("調べ係")];
  it("順番：早い段の後ろ。並列・まとめは最後", () => {
    const p = placeMessages(true, stages, [msg("1", "調べ係", "受信箱係")]);
    expect(p.after.get(0)).toHaveLength(1);
    expect(p.end).toHaveLength(0);
    expect(placeMessages(false, stages, [msg("1", "調べ係", "受信箱係")]).end).toHaveLength(1);
  });
  it("返事は元の連絡の下に続ける", () => {
    const t = threadMessages([msg("1", "a", "b"), msg("2", "b", "a", "1")]);
    expect(t).toHaveLength(1);
    expect(t[0]?.replies[0]?.id).toBe("2");
  });
});
