// モバイルエミュレーションでスクリーンショットを撮る。使い方: npm run shot -- [route...] [--dark] [--drawer]
import { chromium, devices } from 'playwright'

const args = process.argv.slice(2)
const dark = args.includes('--dark')
const drawer = args.includes('--drawer')
const routes = args.filter((a) => !a.startsWith('--'))
const targets = routes.length ? routes : ['/agents', '/agents/news']
const device = devices['Pixel 7']

// WSL の Linux には Chrome の依存ライブラリがないので、Windows 側の Chrome を使う
const browser = await chromium.launch({ channel: 'chrome' })
const ctx = await browser.newContext({ ...device, colorScheme: dark ? 'dark' : 'light', locale: 'ja-JP' })
const page = await ctx.newPage()
for (const r of targets) {
  await page.goto(`http://localhost:5173/#${r}`)
  await page.waitForTimeout(400)
  if (drawer) {
    await page.getByRole('button', { name: 'メニュー' }).click()
    await page.waitForTimeout(400)
  }
  const file = `shots/${r.replace(/\W+/g, '_').replace(/^_/, '') || 'root'}${drawer ? '-drawer' : ''}${dark ? '-dark' : ''}.png`
  await page.screenshot({ path: file })
  console.log(file)
}
await browser.close()
