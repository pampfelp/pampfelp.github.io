const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const baseUrl = process.env.PAGES_BASE_URL ?? 'http://127.0.0.1:8765';

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    args: ['--no-sandbox'],
  });
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('response', response => {
        if (response.status() >= 400 && response.url().includes('/opencut/_next/')) errors.push(`${response.status()} ${response.url()}`);
      });
      const response = await page.goto(`${baseUrl}/opencut/`, { waitUntil: 'domcontentloaded' });
      assert.equal(response.status(), 200);
      await page.getByRole('button', { name: 'Sincronizar com o Google Drive' }).waitFor({ timeout: 30000 });
      await page.getByRole('button', { name: 'Create your first project' }).click();
      await page.waitForURL(url => url.pathname === '/opencut/editor/' && url.searchParams.has('project_id'), { timeout: 30000 });
      await page.getByRole('button', { name: 'Close' }).first().click();
      await page.screenshot({ path: `design/test-tools/pages-${viewport.width}.png` });
      await page.getByRole('button', { name: /Sincronizar.*Google Drive/ }).first().waitFor({ timeout: 30000 });
      if (viewport.width < 500) {
        await page.getByRole('button', { name: 'Mídia' }).click();
        await page.locator('input[type=file]').setInputFiles('design/esqueleto-390.png');
        await page.getByRole('button', { name: 'Adicionar à linha do tempo' }).click();
        await page.getByRole('button', { name: 'Fechar painel' }).click();
        await page.getByRole('button', { name: 'Export', exact: true }).first().click();
        const downloadPromise = page.waitForEvent('download', { timeout: 180000 });
        await page.getByRole('button', { name: 'Export', exact: true }).last().click();
        const download = await downloadPromise;
        assert.equal(await download.failure(), null);
        const mp4 = fs.readFileSync(await download.path());
        assert(mp4.length > 1024);
        assert.equal(mp4.toString('ascii', 4, 8), 'ftyp');
        console.log('export', mp4.length);
      }
      assert.equal(errors.length, 0, errors.join('\n'));
      console.log(JSON.stringify({ viewport, editorUrl: page.url(), errors }));
      await context.close();
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
