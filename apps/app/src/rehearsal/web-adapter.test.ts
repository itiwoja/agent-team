// リハーサルの Web の口（edge の RehearsalWeb）→ sim-world の POST /executions/:id/web の変換の試験（sim-client は偽物）
import type { SimClient } from "@open-team/sim-client";
import { describe, expect, it } from "vitest";
import { rehearsalWebOf } from "./web-adapter.ts";

const WS = "11111111-1111-4111-8111-111111111111";
const EX = "22222222-2222-4222-8222-222222222222";

function fakeSim(result: unknown) {
  const calls: Array<{ kind: string; ref: unknown; arg: string; opts: unknown }> = [];
  const respond = async (kind: string, ref: unknown, arg: string, opts: unknown) => {
    calls.push({ kind, ref, arg, opts });
    return { execution: {} as never, result: result as never, events: [] };
  };
  const sim = { webFetch: (ref: unknown, url: string, opts: unknown) => respond("fetch", ref, url, opts), webSearch: (ref: unknown, q: string, opts: unknown) => respond("search", ref, q, opts) };
  return { sim: sim as unknown as Pick<SimClient, "webFetch" | "webSearch">, calls };
}

describe("rehearsalWebOf：sim-world の応答を edge の口の形にする", () => {
  it("取得（200）は題・本文・最終 URL を返し、実行の ID を bind したものを使う", async () => {
    const { sim, calls } = fakeSim({ kind: "fetch", status: 200, title: "価格表", body: "本文" });
    const b = rehearsalWebOf(sim, WS);
    b.bind(EX);
    const r = await b.web.fetch({ url: "https://news.example.jp/price-list" });
    expect(r).toEqual({ status: 200, title: "価格表", body: "本文", finalUrl: "https://news.example.jp/price-list" });
    expect(calls[0]).toMatchObject({ kind: "fetch", ref: { workspaceId: WS, executionId: EX }, arg: "https://news.example.jp/price-list" });
  });

  it("取得（404）は status 404 で返す（本番の WEB_HTTP_404 になる）", async () => {
    const { sim } = fakeSim({ kind: "fetch", status: 404, message: "ページがない" });
    const b = rehearsalWebOf(sim, WS);
    b.bind(EX);
    expect(await b.web.fetch({ url: "https://news.example.jp/x" })).toMatchObject({ status: 404, body: "ページがない" });
  });

  it("検索は結果の題・URL・抜粋を返す。signal は渡したときだけ渡す", async () => {
    const { sim, calls } = fakeSim({ kind: "search", status: 200, results: [{ title: "価格表", url: "https://news.example.jp/price-list", snippet: "抜粋" }] });
    const b = rehearsalWebOf(sim, WS);
    b.bind(EX);
    const ac = new AbortController();
    expect(await b.web.search({ query: "価格表", signal: ac.signal })).toEqual([{ title: "価格表", url: "https://news.example.jp/price-list", snippet: "抜粋" }]);
    expect(calls[0]).toMatchObject({ kind: "search", arg: "価格表", opts: { signal: ac.signal } });
    await b.web.search({ query: "x" });
    expect(calls[1]!.opts).toEqual({});
  });

  it("bind する前に呼んだら例外（実行が決まっていない）", async () => {
    const { sim } = fakeSim({ kind: "search", status: 200, results: [] });
    await expect(rehearsalWebOf(sim, WS).web.search({ query: "x" })).rejects.toThrow("実行が決まっていない");
  });
});
