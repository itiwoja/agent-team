import { chromium } from "playwright";
const base = process.argv[2] || "http://localhost:5173";
const dir = process.argv[3] || "shots/audit/";
const routes = [
  ["home", "/"], ["check", "/check"], ["done", "/done"], ["audit", "/audit"],
  ["ask-done", "/asks/5c2c2870-5f18-4263-bea7-e6d6f90760bb"],
  ["ask-running", "/asks/a12b4f57-2d55-42cf-8c08-20d96c656eb9"],
  ["ask-failed", "/asks/d5df9446-ddb4-4b61-99fd-c73993482984"],
];
const b = await chromium.launch({ channel: "chrome" });
for (const [vw, vh, tag] of [[390, 844, "m"], [1280, 860, "d"]]) {
  const p = await b.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: tag === "m" ? 2 : 1 });
  await p.goto(base + "/");
  await p.waitForSelector(".entrance", { timeout: 60000 });
  for (const [name, path] of routes) {
    await p.goto(base + path);
    await p.waitForTimeout(2500);
    await p.screenshot({ path: `${dir}${tag}-${name}.png`, fullPage: true });
  }
  await p.close();
}
await b.close();
