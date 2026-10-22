// ワークスペースの見え方（AS §2.3 の WorkspaceView。EP-03 /me と EP-26 が同じ形を返す）
// budget.todayCostUsd はワークスペースのタイムゾーン（すべて Asia/Tokyo：M-59）の今日の usage_records の合計、
// perDayUsd はワークスペースのポリシーの per_day_usd（既定 10：M-59）、remainingUsd = max(0, perDay − today)。

import { getGithubConnection, getGoogleConnection, getWorkspace, system, type MemberRole, type WorkspaceKind, type WsCtx } from "@open-team/db";
import { getLatestWorkspacePolicy, getWorkspaceDayCostUsd } from "@open-team/db/app";
import { defaultWorkspacePolicy, formatUsd, toMicroUsd } from "@open-team/kernel";
import { AppError } from "@open-team/platform";
import { githubInstallationSettingsUrl } from "./connectors/github.ts";
import type { AppDeps } from "./deps.ts";

export interface WorkspaceView {
  id: string;
  kind: WorkspaceKind;
  role: MemberRole;
  timezone: string;
  maxConcurrentTasks: number;
  killSwitch: { engaged: boolean; engagedAt: string | null; engagedBy: string | null; reason: string | null };
  budget: { todayCostUsd: string; perDayUsd: string; remainingUsd: string };
  /** Google カレンダー（16 §3.6）。available＝この環境で「つなぐ」が使えるか、connected・email＝つながっているか */
  google: { available: boolean; connected: boolean; email: string | null };
  /**
   * GitHub（18 §3.6）。available＝この環境で「つなぐ」が使えるか、connected・login＝つながっているか、
   * allowProtectedWrite＝保護したブランチ（既定のブランチ・main・master）への書き込みを許しているか、settingsUrl＝対象のリポジトリを変える GitHub の画面
   */
  github: { available: boolean; connected: boolean; login: string | null; allowProtectedWrite: boolean; settingsUrl: string | null };
}

export async function buildWorkspaceView(deps: Pick<AppDeps, "db" | "clock" | "env">, ctx: WsCtx & { role: MemberRole }): Promise<WorkspaceView> {
  const now = deps.clock.now();
  const ws = await getWorkspace(deps.db, ctx);
  if (!ws) throw new AppError("NOT_FOUND");
  const policy = await getLatestWorkspacePolicy(deps.db, ctx);
  const perDay = (policy?.policy as { budget?: { per_day_usd?: unknown } } | undefined)?.budget?.per_day_usd;
  const perDayUsd = typeof perDay === "number" && Number.isFinite(perDay) ? perDay : defaultWorkspacePolicy().budget.per_day_usd;
  const today = await getWorkspaceDayCostUsd(deps.db, ctx, now, ws.timezone);
  const remainingMicro = Math.max(0, toMicroUsd(perDayUsd) - system.usdToMicro(today));
  const googleConn = await getGoogleConnection(deps.db, ctx);
  const githubConn = await getGithubConnection(deps.db, ctx);
  const githubEnv = deps.env.githubConnect;
  return {
    id: ws.id,
    kind: ws.kind,
    role: ctx.role,
    timezone: ws.timezone,
    maxConcurrentTasks: ws.max_concurrent_tasks,
    killSwitch: {
      engaged: ws.kill_switch_engaged,
      engagedAt: ws.kill_switch_engaged_at?.toISOString() ?? null,
      engagedBy: ws.kill_switch_engaged_by,
      reason: ws.kill_switch_reason,
    },
    budget: { todayCostUsd: system.microToUsd(system.usdToMicro(today)), perDayUsd: formatUsd(perDayUsd), remainingUsd: system.microToUsd(remainingMicro) },
    google: { available: deps.env.googleConnect !== undefined, connected: googleConn !== null, email: googleConn?.email ?? null },
    github: {
      available: githubEnv !== undefined,
      connected: githubConn !== null,
      login: githubConn?.accountLogin ?? null,
      allowProtectedWrite: githubConn?.allowProtectedWrite ?? false,
      settingsUrl: githubConn !== null && githubEnv !== undefined ? githubInstallationSettingsUrl(githubEnv, githubConn.installationId) : null,
    },
  };
}
