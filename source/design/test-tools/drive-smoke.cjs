const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');

const files = new Map();
const sessions = new Map();
let nextId = 1;
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Upload-Content-Type, X-Upload-Content-Length, Content-Range',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, OPTIONS',
  'Access-Control-Expose-Headers': 'Location, Range',
};
const json = (route, body, status = 200, extra = {}) => route.fulfill({
  status, headers: { ...cors, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body),
});

async function handleDrive(route) {
  const request = route.request();
  const url = new URL(request.url());
  const method = request.method();
  if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  if (url.pathname === '/drive/v3/files' && method === 'GET') {
    const parent = url.searchParams.get('q')?.match(/^'([^']+)' in parents/)?.[1];
    const matching = [...files.values()].filter(f => f.parents.includes(parent) && !f.trashed);
    return json(route, { files: matching.map(({ id, name, mimeType, modifiedTime, size }) => ({ id, name, mimeType, modifiedTime, size })) });
  }
  if (url.pathname === '/drive/v3/files' && method === 'POST') {
    const meta = request.postDataJSON();
    const id = `file-${nextId++}`;
    const file = { id, ...meta, content: Buffer.alloc(0), size: '0', trashed: false };
    files.set(id, file);
    return json(route, file);
  }
  if (url.pathname.startsWith('/drive/v3/files/') && method === 'PATCH') {
    const id = url.pathname.split('/').pop();
    const file = files.get(id);
    Object.assign(file, request.postDataJSON());
    return json(route, file);
  }
  if (url.pathname.startsWith('/drive/v3/files/') && method === 'GET') {
    const id = url.pathname.split('/').pop();
    const file = files.get(id);
    return route.fulfill({ status: file ? 200 : 404, headers: { ...cors, 'Content-Type': file?.mimeType ?? 'text/plain' }, body: file?.content ?? '' });
  }
  if (url.pathname.startsWith('/upload/drive/v3/files') && url.searchParams.get('uploadType') === 'resumable') {
    const updateId = url.pathname.split('/')[5];
    const meta = request.postDataJSON();
    const sessionId = `session-${nextId++}`;
    sessions.set(sessionId, { meta, updateId, content: Buffer.alloc(0), total: Number(request.headers()['x-upload-content-length']) });
    return route.fulfill({ status: 200, headers: { ...cors, Location: `https://www.googleapis.com/upload/drive/v3/files?upload_id=${sessionId}` } });
  }
  if (url.pathname === '/upload/drive/v3/files' && method === 'PUT') {
    const session = sessions.get(url.searchParams.get('upload_id'));
    if (!session) return json(route, { error: 'session missing' }, 404);
    const range = request.headers()['content-range'];
    if (range.startsWith('bytes */')) {
      return route.fulfill({ status: 308, headers: { ...cors, Range: `bytes=0-${session.content.length - 1}` } });
    }
    const [, start, end, total] = range.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    assert.equal(Number(start), session.content.length);
    assert.equal(Number(total), session.total);
    const chunk = request.postDataBuffer();
    assert.equal(chunk.length, Number(end) - Number(start) + 1);
    session.content = Buffer.concat([session.content, chunk]);
    if (session.content.length < session.total) {
      return route.fulfill({ status: 308, headers: { ...cors, Range: `bytes=0-${session.content.length - 1}` } });
    }
    const id = session.updateId || `file-${nextId++}`;
    const file = { ...(files.get(id) ?? {}), id, ...session.meta, content: session.content, size: String(session.content.length), modifiedTime: new Date().toISOString(), trashed: false };
    files.set(id, file);
    return json(route, file);
  }
  return json(route, { error: `unhandled ${method} ${url}` }, 500);
}

async function configure(context) {
  await context.route('https://accounts.google.com/gsi/client', route => route.fulfill({
    status: 200, contentType: 'application/javascript', body: `window.google={accounts:{oauth2:{initTokenClient:({callback})=>({requestAccessToken:()=>callback({access_token:'fake-token',expires_in:3600})}),hasGrantedAllScopes:()=>true}}};`,
  }));
  await context.route('https://www.googleapis.com/**', handleDrive);
}

async function closeOnboarding(page) {
  const close = page.getByRole('button', { name: 'Close' });
  try {
    await close.first().waitFor({ state: 'visible', timeout: 10000 });
    await close.first().click();
  } catch {
    // An existing project can skip onboarding.
  }
}
async function readTracks(page, projectId) {
  return page.evaluate(async projectId => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('video-editor-projects');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const project = await new Promise((resolve, reject) => {
      const request = db.transaction('projects').objectStore('projects').get(projectId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return project.scenes[0].tracks;
  }, projectId);
}
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-sandbox'] });
  const first = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await configure(first);
  const pageA = await first.newPage();
  const errors = [];
  pageA.on('pageerror', error => errors.push(error.message));
  await pageA.goto('http://localhost:3000/editor/drive-smoke', { waitUntil: 'domcontentloaded' });
  await pageA.waitForURL(url => url.pathname !== '/editor/drive-smoke');
  await closeOnboarding(pageA);
  const projectId = new URL(pageA.url()).searchParams.get('project_id');
  assert(projectId, 'Editor must include the project ID in the URL');
  await pageA.getByRole('button', { name: 'Mídia' }).click();
  await pageA.locator('input[type=file]').setInputFiles('design/esqueleto-390.png');
  await pageA.getByRole('button', { name: 'Adicionar à linha do tempo' }).click();
  await pageA.getByRole('button', { name: 'Sincronizar com o Google Drive' }).click();
  await pageA.getByRole('button', { name: 'Sincronizar novamente com o Google Drive' }).waitFor({ timeout: 10000 });
  assert.equal(JSON.parse([...files.values()].find(f => f.name === 'project.json').content.toString()).project.metadata.id, projectId);
  if (process.env.TEST_EXPORT) {
    await pageA.getByRole('button', { name: 'Export', exact: true }).first().click();
    const downloadPromise = pageA.waitForEvent('download', { timeout: 180000 });
    await pageA.getByRole('button', { name: 'Export', exact: true }).last().click();
    const download = await downloadPromise;
    assert.equal(await download.failure(), null);
    const exported = fs.readFileSync(await download.path());
    assert(exported.length > 1024, 'Exported MP4 is unexpectedly small');
    assert.equal(exported.toString('ascii', 4, 8), 'ftyp');
    console.log('export', download.suggestedFilename(), exported.length, 'bytes');
  }
  await pageA.close();

  const second = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await configure(second);
  const pageB = await second.newPage();
  pageB.on('pageerror', error => errors.push(error.message));
  await pageB.goto('http://localhost:3000/projects');
  await pageB.getByRole('button', { name: 'Sincronizar com o Google Drive' }).waitFor({ state: 'visible' });
  await pageB.waitForFunction(() => !document.querySelector('button[aria-label="Sincronizar com o Google Drive"]')?.disabled);
  await pageB.getByRole('button', { name: 'Sincronizar com o Google Drive' }).click();
  await pageB.getByRole('link', { name: /Untitled Project/ }).first().waitFor({ timeout: 30000 });
  await pageB.locator(`a[href="/editor?project_id=${projectId}"]`).first().click();
  await closeOnboarding(pageB);
  await pageB.getByRole('button', { name: 'Mídia' }).click();
  await pageB.getByText('esqueleto-390', { exact: false }).first().waitFor({ timeout: 30000 });
  await pageB.getByRole('button', { name: 'Fechar painel' }).click();
  const clip = pageB.locator('button.touch-none').first();
  await clip.waitFor({ timeout: 10000 });
  const bounds = await clip.boundingBox();
  assert(bounds, 'Timeline clip must be visible');
  const touch = await second.newCDPSession(pageB);
  const origin = { x: bounds.x + Math.min(bounds.width / 2, 30), y: bounds.y + bounds.height / 2 };
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [origin] });
  for (let offset = 15; offset <= 90; offset += 15) {
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: origin.x + offset, y: origin.y - offset }] });
    await pageB.waitForTimeout(50);
  }
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await pageB.waitForTimeout(1200);
  const tracksAfterDrag = await readTracks(pageB, projectId);
  const movedClipStart = tracksAfterDrag.overlay[0]?.elements[0]?.startTime ?? 0;
  assert(movedClipStart > 0, `Touch drag did not move clip: ${movedClipStart}`);
  const resizeHandle = pageB.getByRole('button', { name: 'Right resize handle' }).first();
  await resizeHandle.waitFor({ timeout: 10000 });
  await resizeHandle.scrollIntoViewIfNeeded();
  const resizeBounds = await resizeHandle.boundingBox();
  assert(resizeBounds, 'Resize handle must be visible');
  const resizeOrigin = { x: resizeBounds.x + resizeBounds.width / 2, y: resizeBounds.y + resizeBounds.height / 2 };
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [resizeOrigin] });
  for (let offset = 12; offset <= 60; offset += 12) {
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: resizeOrigin.x - offset, y: resizeOrigin.y }] });
    await pageB.waitForTimeout(50);
  }
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await pageB.waitForTimeout(1200);
  const trimmedDuration = (await readTracks(pageB, projectId)).overlay[0]?.elements[0]?.duration;
  assert(trimmedDuration < 600000, `Touch trim did not shorten clip: ${trimmedDuration}`);
  const nameB = pageB.locator('header input[type=text]').first();
  await nameB.click();
  await nameB.fill('Projeto do celular');
  await nameB.press('Enter');
  await pageB.waitForTimeout(500);
  await pageB.getByRole('button', { name: /Sincronizar.*Google Drive/ }).first().click();
  await pageB.getByRole('button', { name: 'Sincronizar novamente com o Google Drive' }).waitFor({ timeout: 30000 });

  const pageA2 = await first.newPage();
  pageA2.on('pageerror', error => errors.push(error.message));
  await pageA2.goto('http://localhost:3000/projects');
  await pageA2.getByRole('button', { name: 'Sincronizar com o Google Drive' }).waitFor({ state: 'visible' });
  await pageA2.getByRole('button', { name: 'Sincronizar com o Google Drive' }).click();
  await pageA2.getByRole('link', { name: /Projeto do celular/ }).first().waitFor({ timeout: 30000 });
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(JSON.stringify({ projectId, driveFiles: files.size, mediaRestored: true, reverseSync: true, movedClipStart, trimmedDuration, errors }, null, 2));
  await browser.close();
})().catch(error => { console.error(error); process.exit(1); });
