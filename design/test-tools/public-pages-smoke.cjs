const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright-core');

async function main() {
  const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-sandbox'] });
  try {
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      for (const [route, title] of [['index.html', 'Edição de vídeo no seu ritmo'], ['privacidade.html', 'Política de privacidade do OpenCut Pessoal'], ['termos.html', 'Termos de uso do OpenCut Pessoal']]) {
        const response = await page.goto(`http://localhost:3070/${route}`);
        assert.equal(response.status(), 200);
        assert.equal(await page.locator('h1').textContent(), title);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${route} transborda em ${width}px`);
        if (route === 'index.html') {
          assert.equal(await page.locator('a[href="privacidade.html"]').count(), 2);
          assert.equal(await page.locator('a[href="termos.html"]').count(), 1);
        }
        await page.screenshot({ path: path.join(__dirname, `../public-${route.replace('.html', '')}-${width}.png`), fullPage: true });
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
