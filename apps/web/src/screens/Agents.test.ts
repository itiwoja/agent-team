import { describe, expect, it } from "vitest";
import type { AgentJobView } from "../api";
import { usesWorkspace } from "./Agents";

const job = (template: AgentJobView["template"]): AgentJobView => ({
  jobId: "00000000-0000-4000-8000-000000000001",
  kind: "once",
  kindLabel: "1回",
  template,
  templateLabel: "",
  status: "active",
  createdAt: "2026-10-14T00:00:00.000Z",
});

describe("usesWorkspace（「作業場を最初に戻す」を出す担当：SG-07）", () => {
  it("作る（dev-coder）・見直す（reviewer）の仕事がある担当だけ", () => {
    expect(usesWorkspace({ jobs: [job("dev-coder")] })).toBe(true);
    expect(usesWorkspace({ jobs: [job("researcher"), job("reviewer")] })).toBe(true);
    expect(usesWorkspace({ jobs: [job("researcher"), job("watcher"), job("assistant")] })).toBe(false);
    expect(usesWorkspace({ jobs: [] })).toBe(false);
  });
});
