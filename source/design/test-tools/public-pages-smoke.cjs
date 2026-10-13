const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright-core');
const baseUrl = process.env.PUBLIC_PAGES_BASE_URL ?? 'http://localhost:3070';

async function main() {
  const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-sandbox'] });
  try {
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const home = await page.goto(`${baseUrl}/`);
      assert.equal(home.status(), 200);
      await page.waitForURL(`${baseUrl}/opencut/`);
      for (const [route, title] of [['sobre.html', 'Edição de vídeo no seu ritmo'], ['privacidade.html', 'Política de privacidade do OpenCut Pessoal'], ['termos.html', 'Termos de uso do OpenCut Pessoal']]) {
        const response = await page.goto(`${baseUrl}/${route}`);
        assert.equal(response.status(), 200);
        assert.equal(await page.locator('h1').textContent(), title);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${route} transborda em ${width}px`);
        if (route === 'sobre.html') {
          assert.equal(await page.locator('a[href="privacidade.html"]').count(), 2);
          assert.equal(await page.locator('a[href="termos.html"]').count(), 1);
        }
        const screenshotName = route === 'sobre.html' ? 'index' : route.replace('.html', '');
        await page.screenshot({ path: path.join(__dirname, `../public-${screenshotName}-${width}.png`), fullPage: true });
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
