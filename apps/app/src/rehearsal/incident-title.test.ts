import { describe, expect, it } from "vitest";
import { incidentReasonLabel, incidentTitle, plainIncidentTitle } from "./incident-title.ts";

describe("本番の停止から足した試験の題", () => {
  it("止まり方と理由を平易な日本語にする（英語のコードを出さない）", () => {
    expect(incidentTitle("user_reject", "approval_required")).toBe("本番で止まった：確認で却下した（人の確認が必要）");
    expect(incidentTitle("kernel_approve", "guard_exceeded")).toBe("本番で止まった：確認に回った（値の上限を超えた）");
    expect(incidentTitle("kernel_deny", "budget_exceeded")).toBe("本番で止まった：止められた（費用の上限）");
    expect(incidentTitle("kill_switch", "kill_switch")).toBe("本番で止まった：Kill Switch で止めた");
    for (const code of ["guard_exceeded", "approval_required", "unknown_outcome_pending", "breaker_tripped", "intent_limit", "not_granted", "tool_needs_review", "certificate_missing", "made_up_code"]) {
      const t = incidentTitle("kernel_deny", code);
      expect(t, code).not.toMatch(/[a-z]_[a-z]/);
      expect(t.length).toBeLessThanOrEqual(60);
    }
    expect(incidentReasonLabel("made_up_code")).toBe("その他の理由");
  });

  it("古い題の（英語のコード）は出すときに訳に直す。ほかの題はそのまま", () => {
    expect(plainIncidentTitle("本番で止まった：確認で却下した（approval_required）")).toBe("本番で止まった：確認で却下した（人の確認が必要）");
    expect(plainIncidentTitle("本番で止まった：Kill Switch で止めた（kill_switch）")).toBe("本番で止まった：Kill Switch で止めた");
    expect(plainIncidentTitle("本番で止まった：確認で却下した（人の確認が必要）")).toBe("本番で止まった：確認で却下した（人の確認が必要）");
    expect(plainIncidentTitle("豆の値上がり（approval_required）")).toBe("豆の値上がり（approval_required）");
  });
});
