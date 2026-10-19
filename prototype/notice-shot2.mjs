import { chromium } from "playwright";
const out = "shots/notice/";
const ASK = "c85820c5-6409-4ecf-853b-fb6770ae8960";
const b = await chromium.launch({ channel: "chrome" });
for (const scheme of ["light"]) {
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: scheme });
  await p.addInitScript(() => {
    const Orig = window.EventSource;
    window.__es = [];
    window.EventSource = function (u, o) { const e = new Orig(u, o); window.__es.push(e); return e; };
    window.EventSource.prototype = Orig.prototype;
    Object.assign(window.EventSource, { CONNECTING: 0, OPEN: 1, CLOSED: 2 });
  });
  await p.goto("http://localhost:5173/check");
  await p.waitForSelector(".check-page", { timeout: 60000 });
  // 本物の依頼の回答を引いて、届いた事象としてそのまま流す
  const ok = await p.evaluate(async (askId) => {
    const d = await (await fetch(`/api/v1/asks/${askId}`, { credentials: "include" })).json();
    if (!d.answer) return "no answer";
    const data = JSON.stringify({ type: "ask.answered", askId, runId: d.run?.runId ?? "run-x", answer: d.answer });
    window.__es.forEach((e) => e.dispatchEvent(new MessageEvent("ask.answered", { data })));
    return d.ask.text;
  }, ASK);
  console.log(scheme, ok);
  await p.waitForSelector(".notice", { timeout: 10000 });
  await p.waitForTimeout(700);
  await p.screenshot({ path: `${out}1-toast-${scheme}.png` });
  await p.click(".notice-main");
  await p.waitForTimeout(500);
  await p.screenshot({ path: `${out}2-sheet-${scheme}.png` });
  if (scheme === "light") {
    console.log(await p.innerText(".notice-sheet"));
    await p.click("text=くわしく");
    await p.waitForSelector(".report-card", { timeout: 20000 });
    await p.waitForTimeout(800);
    await p.screenshot({ path: `${out}3-askpage.png` });
  }
  await p.close();
}
await b.close();
