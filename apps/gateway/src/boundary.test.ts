// 接続先の境界（MT §3.12.2・§6.9、SO §3.2・§7.2、BR-63・64・66・67②）。順は public → guest → shadow → rehearsal
import { describe, expect, it } from "vitest";
import { SIM_GCAL_PATH as SIM_CORE_GCAL_PATH } from "@open-team/sim-core";
import { connectorBoundary, effectiveConnectorUrl, isOwnOAuthConnector, isSimWorldUrl, originOf, SIM_GCAL_PATH, type BoundaryInput } from "./boundary.ts";

const SIM = "https://sim-world-123.asia-northeast1.run.app";
const GCAL = "https://gcal-123.asia-northeast1.run.app";
const GCAL_ORIGIN = GCAL;
const OAUTH = { type: "oauth", provider: "google" } as const;
const base: BoundaryInput = {
  deploymentMode: "cloud",
  allowedOrigins: [SIM],
  simWorldOrigin: SIM,
  workspaceKind: "owner",
  rehearsalRunId: null,
  shadow: false,
  connectorUrl: `${SIM}/mcp/shop/supplier`,
  ownOAuthConnector: false,
};

describe("connectorBoundary", () => {
  it("SO-BD-01・BD-01 公開デプロイ・オーナー・https://evil.example/mcp → public_deployment", () => {
    expect(connectorBoundary({ ...base, connectorUrl: "https://evil.example/mcp" })).toEqual({ ok: false, reasonCode: "public_deployment" });
  });
  it("SO-BD-02・BD-02 公開デプロイ・ゲスト・同じ URL → public_deployment（BR-66 を先に見る）", () => {
    expect(connectorBoundary({ ...base, workspaceKind: "guest", connectorUrl: "https://evil.example/mcp" })).toEqual({
      ok: false,
      reasonCode: "public_deployment",
    });
  });
  it("影・リハーサルでも公開デプロイの外は public_deployment が先", () => {
    expect(connectorBoundary({ ...base, shadow: true, rehearsalRunId: "r", connectorUrl: "https://evil.example/mcp" })).toEqual({
      ok: false,
      reasonCode: "public_deployment",
    });
  });
  it("SO-BD-03・BD-03 公開デプロイ・ゲスト・sim-world の URL → ok（影・リハーサルも ok）", () => {
    expect(connectorBoundary({ ...base, workspaceKind: "guest" })).toEqual({ ok: true });
    expect(connectorBoundary({ ...base, workspaceKind: "guest", shadow: true, rehearsalRunId: "r" })).toEqual({ ok: true });
  });
  it("SO-BD-04 sim-world のホスト名を前に付けた別のホスト → public_deployment（origin の比較）", () => {
    expect(connectorBoundary({ ...base, connectorUrl: `${SIM}.evil.com/mcp/shop/supplier` })).toEqual({ ok: false, reasonCode: "public_deployment" });
  });
  it("公開デプロイで読めない URL → public_deployment（閉じた側）", () => {
    expect(connectorBoundary({ ...base, connectorUrl: "::bad::" })).toEqual({ ok: false, reasonCode: "public_deployment" });
  });

  const local: BoundaryInput = { ...base, deploymentMode: "local", allowedOrigins: [], connectorUrl: "https://real-mcp.example/mcp" };
  it("SO-BD-05 local（実の URL を許す）・ゲスト・実の URL → guest_workspace", () => {
    expect(connectorBoundary({ ...local, workspaceKind: "guest" })).toEqual({ ok: false, reasonCode: "guest_workspace" });
  });
  it("SO-BD-06・BD-08 local・オーナー・shadow = true・実の URL → shadow_real_connector", () => {
    expect(connectorBoundary({ ...local, shadow: true, rehearsalRunId: "r" })).toEqual({ ok: false, reasonCode: "shadow_real_connector" });
  });
  it("SO-BD-07・BD-09 local・オーナー・rehearsal_run_id あり・実の URL → rehearsal_real_connector", () => {
    expect(connectorBoundary({ ...local, rehearsalRunId: "r" })).toEqual({ ok: false, reasonCode: "rehearsal_real_connector" });
  });
  it("順番：ゲストの影は guest_workspace が先、ゲストでない影は shadow が先", () => {
    expect(connectorBoundary({ ...local, workspaceKind: "guest", shadow: true, rehearsalRunId: "r" })).toEqual({ ok: false, reasonCode: "guest_workspace" });
  });
  it("local・オーナーの本番は実のコネクタを使える（フェーズ0）", () => {
    expect(connectorBoundary(local)).toEqual({ ok: true });
  });
  it("SIM_WORLD_URL がない local：ゲスト・影・リハーサルはどの URL も sim-world ではない（全部拒否）", () => {
    const noSim = { ...local, simWorldOrigin: null, connectorUrl: `${SIM}/mcp/shop/supplier` };
    expect(connectorBoundary({ ...noSim, workspaceKind: "guest" })).toEqual({ ok: false, reasonCode: "guest_workspace" });
    expect(connectorBoundary({ ...noSim, rehearsalRunId: "r" })).toEqual({ ok: false, reasonCode: "rehearsal_real_connector" });
  });
});

describe("isSimWorldUrl（MT §3.12.2）", () => {
  it("origin が同じでパスが /mcp/ で始まるときだけ", () => {
    expect(isSimWorldUrl(`${SIM}/mcp/shop/store`, SIM)).toBe(true);
    expect(isSimWorldUrl(`${SIM}/admin/v1/demo-store`, SIM)).toBe(false);
    expect(isSimWorldUrl(`${SIM}/mcp`, SIM)).toBe(false);
    expect(isSimWorldUrl(`${SIM}:8443/mcp/shop/store`, SIM)).toBe(false);
    expect(isSimWorldUrl(`${SIM.replace("https", "http")}/mcp/shop/store`, SIM)).toBe(false);
    expect(isSimWorldUrl(SIM.replace("https://", "https://u:p@") + "/mcp/shop/store", SIM)).toBe(false);
    expect(isSimWorldUrl(`${SIM}/mcp/shop/store`, null)).toBe(false);
    expect(isSimWorldUrl("::bad::", SIM)).toBe(false);
  });
  it("originOf：読めなければ null", () => {
    expect(originOf(`${SIM}/mcp/x`)).toBe(SIM);
    expect(originOf("nope")).toBeNull();
  });
});

describe("Google カレンダーのコネクタ（16 §3.5、ADR-040）", () => {
  const gcalBase: BoundaryInput = {
    ...base,
    allowedOrigins: [SIM, GCAL],
    connectorUrl: `${GCAL}/mcp/gcal`,
    ownOAuthConnector: true,
  };
  it("isOwnOAuthConnector：oauth（google）で origin が GCAL_URL と同じときだけ", () => {
    expect(isOwnOAuthConnector({ url: `${GCAL}/mcp/gcal`, auth: OAUTH }, GCAL_ORIGIN)).toBe(true);
    expect(isOwnOAuthConnector({ url: `${SIM}/mcp/gcal`, auth: OAUTH }, GCAL_ORIGIN)).toBe(false);
    expect(isOwnOAuthConnector({ url: `${GCAL}/mcp/gcal`, auth: { type: "none" } }, GCAL_ORIGIN)).toBe(false);
    expect(isOwnOAuthConnector({ url: `${GCAL}/mcp/gcal`, auth: OAUTH }, null)).toBe(false);
  });
  it("ゲストでも自分の Google カレンダー（origin が許可の一覧にある）は通す（規則2の例外）", () => {
    expect(connectorBoundary({ ...gcalBase, workspaceKind: "guest" })).toEqual({ ok: true });
  });
  it("ゲストで oauth でも origin が GCAL_URL と違う（ownOAuthConnector = false）→ guest_workspace", () => {
    const other = "https://other-gcal.example.run.app";
    const ownOther = isOwnOAuthConnector({ url: `${other}/mcp/gcal`, auth: OAUTH }, GCAL_ORIGIN);
    expect(ownOther).toBe(false);
    expect(connectorBoundary({ ...gcalBase, workspaceKind: "guest", allowedOrigins: [SIM, GCAL, other], connectorUrl: `${other}/mcp/gcal`, ownOAuthConnector: ownOther })).toEqual({
      ok: false,
      reasonCode: "guest_workspace",
    });
  });
  it("リハーサルの走行の Google カレンダー → rehearsal_real_connector（規則4は変えない）", () => {
    expect(connectorBoundary({ ...gcalBase, rehearsalRunId: "r" })).toEqual({ ok: false, reasonCode: "rehearsal_real_connector" });
  });
  it("影の Google カレンダー → shadow_real_connector（規則3は変えない）", () => {
    expect(connectorBoundary({ ...gcalBase, shadow: true })).toEqual({ ok: false, reasonCode: "shadow_real_connector" });
  });
  it("cloud で GCAL_URL の origin が許可の一覧にない → public_deployment", () => {
    expect(connectorBoundary({ ...gcalBase, allowedOrigins: [SIM] })).toEqual({ ok: false, reasonCode: "public_deployment" });
  });
  it("local・オーナーの本番の Google カレンダーは通す", () => {
    expect(connectorBoundary({ ...gcalBase, deploymentMode: "local", allowedOrigins: [], simWorldOrigin: null })).toEqual({ ok: true });
  });
});

describe("effectiveConnectorUrl（16 §6.1）：リハーサル・影の本人の Google カレンダーを模擬へ向ける", () => {
  const gcalConn = { url: `${GCAL}/mcp/gcal`, auth: OAUTH } as const;
  const sim = { simWorldUrl: SIM, gcalOrigin: GCAL_ORIGIN };
  const simGcal = `${SIM}/mcp/shop/gcal`;

  it("SIM_GCAL_PATH は sim-core の SIM_GCAL_PATH と同じ（写しのずれを試験で止める）", () => {
    expect(SIM_GCAL_PATH).toBe(SIM_CORE_GCAL_PATH);
  });
  it("リハーサルの走行・影の本人の Google カレンダー → SIM_WORLD_URL + SIM_GCAL_PATH", () => {
    expect(effectiveConnectorUrl(sim, gcalConn, { rehearsalRunId: "r", shadow: false })).toBe(simGcal);
    expect(effectiveConnectorUrl(sim, gcalConn, { rehearsalRunId: null, shadow: true })).toBe(simGcal);
    expect(effectiveConnectorUrl(sim, gcalConn, { rehearsalRunId: "r", shadow: true })).toBe(simGcal);
  });
  it("SIM_WORLD_URL の末尾の / は落とす（二重の / にしない）", () => {
    expect(effectiveConnectorUrl({ ...sim, simWorldUrl: `${SIM}/` }, gcalConn, { rehearsalRunId: "r", shadow: false })).toBe(simGcal);
  });
  it("オーナーの本番の呼び出し（リハーサルでも影でもない）は差し替えない", () => {
    expect(effectiveConnectorUrl(sim, gcalConn, { rehearsalRunId: null, shadow: false })).toBe(gcalConn.url);
  });
  it("本人の Google カレンダーでないコネクタ（auth none・別の origin）は差し替えない", () => {
    expect(effectiveConnectorUrl(sim, { url: `${GCAL}/mcp/gcal`, auth: { type: "none" } }, { rehearsalRunId: "r", shadow: false })).toBe(`${GCAL}/mcp/gcal`);
    expect(effectiveConnectorUrl(sim, { url: `${SIM}/mcp/shop/supplier`, auth: { type: "none" } }, { rehearsalRunId: "r", shadow: false })).toBe(`${SIM}/mcp/shop/supplier`);
    expect(effectiveConnectorUrl({ ...sim, gcalOrigin: null }, gcalConn, { rehearsalRunId: "r", shadow: false })).toBe(gcalConn.url);
  });
  it("SIM_WORLD_URL がなければ差し替えず、規則3・4 で拒否される（影・リハーサルとも）", () => {
    const noSim = { simWorldUrl: null, gcalOrigin: GCAL_ORIGIN };
    const url = effectiveConnectorUrl(noSim, gcalConn, { rehearsalRunId: "r", shadow: false });
    expect(url).toBe(gcalConn.url);
    const b: BoundaryInput = { ...base, deploymentMode: "local", allowedOrigins: [], simWorldOrigin: null, connectorUrl: url, ownOAuthConnector: true };
    expect(connectorBoundary({ ...b, rehearsalRunId: "r" })).toEqual({ ok: false, reasonCode: "rehearsal_real_connector" });
    expect(connectorBoundary({ ...b, shadow: true })).toEqual({ ok: false, reasonCode: "shadow_real_connector" });
  });
  it("差し替えた先は sim-world のコネクタとして境界を通る（リハーサル・影・ゲストでも）", () => {
    const u = effectiveConnectorUrl(sim, gcalConn, { rehearsalRunId: "r", shadow: false });
    const b: BoundaryInput = { ...base, allowedOrigins: [SIM, GCAL], connectorUrl: u, ownOAuthConnector: true, rehearsalRunId: "r" };
    expect(connectorBoundary(b)).toEqual({ ok: true });
    expect(connectorBoundary({ ...b, shadow: true, rehearsalRunId: null })).toEqual({ ok: true });
    expect(connectorBoundary({ ...b, workspaceKind: "guest" })).toEqual({ ok: true });
  });
  it("オーナーの本番の Google カレンダーは差し替えず、そのまま通る", () => {
    const u = effectiveConnectorUrl(sim, gcalConn, { rehearsalRunId: null, shadow: false });
    expect(connectorBoundary({ ...base, allowedOrigins: [SIM, GCAL], connectorUrl: u, ownOAuthConnector: true })).toEqual({ ok: true });
  });
});
