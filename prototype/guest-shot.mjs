import { chromium } from "playwright";
const base = process.argv[2] || "http://localhost:5174";
const token = process.env.GT;
const b = await chromium.launch({ channel: "chrome" });
for (const [vw, vh, tag] of [[1280, 900, "d"], [390, 844, "m"]]) {
  const ctx = await b.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: tag === "m" ? 2 : 1 });
  // ローカルのトークンなしの入口（オーナー）を塞いで、入口のフォームにゲストのトークンを入れる
  await ctx.route("**/api/v1/entry/local", (r) => r.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
  const p = await ctx.newPage();
  await p.goto(base + "/");
  await p.waitForTimeout(3000);
  const hasToken = await p.$("#token");
  console.log(tag, "token-form:", !!hasToken, p.url());
  if (hasToken) {
    await p.fill("#token", token);
    await p.keyboard.press("Enter");
    await p.waitForURL(/\/asks\//, { timeout: 120000 }).catch(() => {});
  }
  await p.waitForURL(/\/asks\//, { timeout: 120000 }).catch(() => {});
  await p.waitForTimeout(6000);
  console.log(tag, "at", p.url());
  await p.screenshot({ path: `shots/guest-${tag}-ask.png`, fullPage: true });
  await p.goto(base + "/check");
  await p.waitForTimeout(4000);
  await p.screenshot({ path: `shots/guest-${tag}-check.png`, fullPage: true });
  await ctx.close();
}
await b.close();
