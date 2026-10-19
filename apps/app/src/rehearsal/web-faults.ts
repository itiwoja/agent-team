// F-14（Web のページに仕込まれた指示）と模擬のカレンダー（F-15〜F-17・gcal.* の道具）の配線の決まり（純粋な関数だけ）。
// - 付与（grants.web.allow_domains）のない仕事には F-14 を出さない（世界の使える障害から外す）
// - 付与（grants.mcp の gcal）のない仕事には gcal.* の道具と F-15〜F-17 を出さない（F-01・F-07・F-08・F-14 の gcal の変種も道具から外れて拒まれる）
// - F-14 の host は app が決める（LLM に書かせない）："*" なら模擬の既定ドメイン、"*.a.jp" なら news.a.jp、具体的なドメインならそれ
// - 読まれたか（fault の事象 faultId F-14）は判定の注記に使う

import { GCAL_CALENDAR_FAULTS, WEB_DEFAULT_HOST } from "@open-team/sim-core";
import type { FaultId, ScenarioContext, SimEvent } from "@open-team/sim-core";
import { GCAL_SLUG } from "@open-team/gcal-core";
import { WEB_POLICIES, type WebAllowDomains } from "./web-grant.ts";

export const F14_ID = "F-14";

/** 仕事に gcal のコネクタの付与があるか（mcp.grants に gcal とツールが1つ以上）。付与の slug の並び（rehearsalGrantsOf の connectorSlugs）から決める */
export function hasCalendarGrant(connectorSlugs: readonly string[]): boolean {
  return connectorSlugs.includes(GCAL_SLUG);
}

/** 仕事に Web の付与があるか（allow_domains が空でない） */
export function hasWebGrant(webAllowDomains: readonly string[]): boolean {
  return webAllowDomains.length > 0;
}

/**
 * その仕事の文脈：
 * - 取得できる host がなければ（付与がない・全部拒否）F-14 を使える障害から外す（生成・解釈の検証で F-14 は「この世界では使えません」になる）
 * - gcal の付与がなければ、F-15〜F-17 を使える障害から外し、gcal.* の道具を世界の道具から外す（validateScenarioContext が gcal.* の障害・lureInvite を拒む）
 * connectorSlugs は省略すると付与なし（gcal を出さない）
 */
export function scenarioContextFor(base: ScenarioContext, webAllowDomains: readonly string[], connectorSlugs: readonly string[] = []): ScenarioContext {
  const withWeb: ScenarioContext = f14HostFor(webAllowDomains) !== null
    ? base
    : { ...base, supportedFaults: base.supportedFaults.filter((id) => id !== F14_ID) };
  if (hasCalendarGrant(connectorSlugs)) return withWeb;
  const calendarFaults: readonly FaultId[] = GCAL_CALENDAR_FAULTS;
  return {
    ...withWeb,
    supportedFaults: withWeb.supportedFaults.filter((id) => !calendarFaults.includes(id)),
    tools: withWeb.tools.filter((t) => !t.startsWith(`${GCAL_SLUG}.`)),
  };
}

/**
 * F-14 のページを置くドメイン（付与の先頭から決める。付与がなければ null）。
 * "*" が含まれれば既定の模擬ドメイン（news.example.jp）、"*.a.jp" は news.a.jp、具体的なドメインはそれ自身。
 */
export function f14HostFor(webAllowDomains: readonly string[], webDenyDomains: readonly string[] = []): string | null {
  if (!hasWebGrant(webAllowDomains)) return null;
  const policies = (webAllowDomains as WebAllowDomains)[WEB_POLICIES];
  if (webDenyDomains.length === 0 && policies !== undefined) {
    for (const policy of policies) {
      const host = f14HostFor(policy.allow, policy.deny);
      if (host !== null) return host;
    }
    return null;
  }
  const candidates = webAllowDomains.map((rule) => rule === "*" ? WEB_DEFAULT_HOST : rule.startsWith("*.") ? `news.${rule.slice(2)}` : rule);
  return candidates.find((host) => !webDenyDomains.some((deny) => deny === "*" || (deny.startsWith("*.") ? host.endsWith(deny.slice(1)) : host === deny))) ?? null;
}

/**
 * LLM の出力のうち、状況の下書き（{ faults: [...] }）の F-14 の host を app の決めた値に置き換える（付与がなければ host を外す）。
 * 下書きの形でなければそのまま返す（検証は呼び出し側の Zod が見る）
 */
export function withF14HostOf(draft: unknown, webAllowDomains: readonly string[], webDenyDomains: readonly string[] = []): unknown {
  if (typeof draft !== "object" || draft === null || !("faults" in draft) || !Array.isArray(draft.faults)) return draft;
  const host = f14HostFor(webAllowDomains, webDenyDomains);
  const faults = draft.faults.map((f: unknown) => {
    if (typeof f !== "object" || f === null || !("id" in f) || f.id !== F14_ID) return f;
    const { host: _llmHost, ...rest } = f as Record<string, unknown>;
    // host がなければ外さずに残す（検証で「この世界では使えません」と理由つきで拒まれる）
    return host === null ? rest : { ...rest, host };
  });
  return { ...draft, faults };
}

/** 事象の中に F-14 のページを読んだ（または見せた）記録があるか */
export function f14PageReadOf(events: readonly SimEvent[]): boolean {
  return events.some((e) => e.kind === "fault" && typeof e.result === "object" && e.result !== null && "faultId" in e.result && e.result.faultId === F14_ID);
}
