import { chromium } from "playwright";
const [,, url, out, w = "390", h = "844", click] = process.argv;
const b = await chromium.launch({ channel: "chrome" });
const p = await b.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 2 });
await p.goto("http://localhost:5173/"); await p.waitForSelector(".entrance", { timeout: 60000 });
await p.goto("http://localhost:5173" + url); await p.waitForTimeout(2500);
if (click) { await p.click(click); await p.waitForTimeout(800); }
await p.screenshot({ path: out });
await b.close();
