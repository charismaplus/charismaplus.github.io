import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(pathToFileURL(path.join(repositoryRoot, '..', 'HarborRealmGame', 'node_modules', 'playwright', 'index.mjs')).href);
const config = JSON.parse(await readFile(path.join(repositoryRoot, '.local', 'kiok-deployment.json'), 'utf8'));
const siteRoot = path.join(repositoryRoot, '.local', 'kiok-package', 'site');
const prefix = `/${config.sitePath}`;
const entryPath = `${prefix}/${config.entryFile}`;
const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'], ['.woff', 'font/woff'], ['.woff2', 'font/woff2'], ['.txt', 'text/plain; charset=utf-8'],
]);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === prefix || url.pathname === `${prefix}/` || !url.pathname.startsWith(`${prefix}/`)) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    const relative = decodeURIComponent(url.pathname.slice(prefix.length + 1));
    const candidate = path.resolve(siteRoot, relative);
    if (!candidate.startsWith(`${path.resolve(siteRoot)}${path.sep}`)) throw new Error('Path escaped package root.');
    const candidateInfo = await stat(candidate).catch(() => null);
    const file = candidateInfo?.isDirectory() ? path.join(candidate, 'index.html') : candidate;
    const fileInfo = await stat(file).catch(() => null);
    if (!fileInfo?.isFile()) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': mimeTypes.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream' });
    response.end(await readFile(file));
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(String(error));
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Could not start KIOK verification server.');
const origin = `http://127.0.0.1:${address.port}`;

let browser;
try {
  const directoryResponse = await fetch(`${origin}${prefix}/`);
  if (directoryResponse.status !== 404) throw new Error(`Hidden KIOK directory must return 404, got ${directoryResponse.status}.`);
  const entryResponse = await fetch(`${origin}${entryPath}`);
  if (entryResponse.status !== 200) throw new Error(`Private KIOK entry failed: ${entryResponse.status}.`);

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const reports = [];
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
    page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
    page.on('requestfailed', (request) => errors.push(`request: ${request.url()} ${request.failure()?.errorText ?? ''}`));
    await page.goto(`${origin}${entryPath}`, { waitUntil: 'networkidle' });
    const homeAudit = await page.evaluate(() => ({
      title: document.title,
      robots: document.querySelector('meta[name="robots"]')?.content,
      referrer: document.querySelector('meta[name="referrer"]')?.content,
      canonical: document.querySelector('link[rel="canonical"]')?.href ?? null,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      heading: document.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim(),
    }));
    if (!homeAudit.robots?.includes('noindex') || homeAudit.referrer !== 'no-referrer' || homeAudit.canonical) {
      throw new Error(`KIOK privacy metadata failed: ${JSON.stringify(homeAudit)}`);
    }
    if (homeAudit.overflow > 1 || !homeAudit.heading) throw new Error(`KIOK home layout failed: ${JSON.stringify(homeAudit)}`);

    await page.getByRole('navigation', { name: '주요 탐색' }).getByRole('link', { name: 'Architecture', exact: true }).click();
    await page.waitForLoadState('networkidle');
    if (!new URL(page.url()).pathname.startsWith(`${prefix}/wiki`)) throw new Error('KIOK wiki navigation escaped the hidden path.');
    const wikiAudit = await page.evaluate(() => ({
      robots: document.querySelector('meta[name="robots"]')?.content,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      heading: document.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim(),
      localLinks: [...document.querySelectorAll('a[href^="/"]')].every((link) => link.getAttribute('href').startsWith(location.pathname.split('/').slice(0, 2).join('/') + '/')),
    }));
    if (!wikiAudit.robots?.includes('noindex') || wikiAudit.overflow > 1 || !wikiAudit.heading || !wikiAudit.localLinks) {
      throw new Error(`KIOK wiki layout or path scope failed: ${JSON.stringify(wikiAudit)}`);
    }
    if (errors.length) throw new Error(`KIOK browser errors: ${JSON.stringify(errors)}`);
    reports.push({ viewport, homeTitle: homeAudit.title, homeOverflow: homeAudit.overflow, wikiOverflow: wikiAudit.overflow, errors: 0 });
    await context.close();
  }
  console.log(JSON.stringify({ ok: true, browser: 'installed Chrome', hiddenDirectoryStatus: 404, entryStatus: 200, reports }, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
