import { describe, expect, it } from "vitest";
import { DEFAULT_GOOGLE_CALENDAR_API_BASE, readGcalEnv } from "./env.ts";

const TOKEN = "s".repeat(32);
const CLOUD = {
  DEPLOYMENT_MODE: "cloud",
  GCAL_URL: "https://gcal-123.asia-northeast1.run.app",
  GATEWAY_SA_EMAIL: "sa-gateway@proj.iam.gserviceaccount.com",
};

describe("readGcalEnv（16 §3.2）", () => {
  it("local は共有トークン GCAL_SHARED_TOKEN が要る。API の基底は既定値", () => {
    expect(readGcalEnv({}).missing).toEqual(["GCAL_SHARED_TOKEN"]);
    const ok = readGcalEnv({ GCAL_SHARED_TOKEN: TOKEN, PORT: "8083" });
    expect(ok.missing).toEqual([]);
    expect(ok.env).toMatchObject({ deploymentMode: "local", port: 8083, sharedToken: TOKEN, googleCalendarApiBase: DEFAULT_GOOGLE_CALENDAR_API_BASE });
  });

  it("cloud は GCAL_URL と GATEWAY_SA_EMAIL が要る（共有トークンは見ない）", () => {
    expect(readGcalEnv({ DEPLOYMENT_MODE: "cloud" }).missing).toEqual(["GCAL_URL", "GATEWAY_SA_EMAIL"]);
    const ok = readGcalEnv({ ...CLOUD, GCAL_SHARED_TOKEN: TOKEN });
    expect(ok.missing).toEqual([]);
    expect(ok.env).toMatchObject({ selfUrl: CLOUD.GCAL_URL, gatewaySaEmail: CLOUD.GATEWAY_SA_EMAIL, sharedToken: undefined });
  });

  it("GOOGLE_CALENDAR_API_BASE で差し替え（末尾の / は外す）", () => {
    const r = readGcalEnv({ GCAL_SHARED_TOKEN: TOKEN, GOOGLE_CALENDAR_API_BASE: "http://127.0.0.1:9999/calendar/v3/" });
    expect(r.env.googleCalendarApiBase).toBe("http://127.0.0.1:9999/calendar/v3");
  });
});
