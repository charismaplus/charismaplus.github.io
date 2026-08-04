import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encryptBuffer } from './decrypt.mjs';

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));
const localRoot = path.join(repositoryRoot, '.local');
const configPath = path.join(localRoot, 'deployment.json');
const packageRoot = path.join(localRoot, 'package');
const siteRoot = path.join(packageRoot, 'site');
const publicRoot = path.join(packageRoot, 'root');
const archivePath = path.join(localRoot, 'deployment.tar.gz');
const bundlePath = path.join(repositoryRoot, 'site.bundle.enc');
const reportPath = path.join(localRoot, 'deployment-report.json');

const sourceFlagIndex = process.argv.indexOf('--source');
if (sourceFlagIndex < 0 || !process.argv[sourceFlagIndex + 1]) {
  throw new Error('Usage: node prepare-local.mjs --source <design-wiki-site-directory>');
}
const sourceRoot = path.resolve(process.argv[sourceFlagIndex + 1]);

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walkFiles(absolute));
    else if (entry.isFile()) output.push(absolute);
  }
  return output;
}

async function loadOrCreateConfig() {
  const config = await exists(configPath)
    ? JSON.parse(await readFile(configPath, 'utf8'))
    : { createdAt: new Date().toISOString() };
  config.repository = 'charismaplus.github.io';
  if (!config.siteKey || config.siteKey.length < 48) config.siteKey = randomBytes(48).toString('base64url');
  if (!/^[a-z0-9-]{24,80}$/.test(config.sitePath ?? '')) config.sitePath = `records-${randomBytes(20).toString('hex')}`;
  if (!/^briefing-[a-f0-9]{32}\.html$/.test(config.entryFile ?? '')) config.entryFile = `briefing-${randomBytes(16).toString('hex')}.html`;
  await mkdir(localRoot, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return config;
}

const privacyMeta = [
  '  <meta name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex">',
  '  <meta name="googlebot" content="noindex, nofollow, noarchive, nosnippet, noimageindex">',
  '  <meta name="bingbot" content="noindex, nofollow, noarchive, nosnippet, noimageindex">',
  '  <meta name="referrer" content="no-referrer">',
].join('\n');

function privateRootDocument(title, message) {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
${privacyMeta}
  <title>${title}</title>
  <style>
    :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#06191d;color:#d8cfb9;font:16px/1.75 system-ui,sans-serif}main{max-width:560px;padding:42px;border:1px solid #38535a;background:#0a2429}h1{margin:0 0 14px;color:#e4b25b;font:600 clamp(28px,7vw,44px)/1.2 Georgia,serif}p{margin:0;color:#aebfba}
  </style>
</head>
<body><main><h1>${title}</h1><p>${message}</p></main></body>
</html>`;
}

const config = await loadOrCreateConfig();
if (!/^[a-z0-9-]{24,80}$/.test(config.sitePath)) throw new Error('Local sitePath is invalid.');
if (!/^briefing-[a-f0-9]{32}\.html$/.test(config.entryFile)) throw new Error('Local entryFile is invalid.');
if (!config.siteKey || config.siteKey.length < 48) throw new Error('Local siteKey is invalid.');
if (!(await exists(path.join(sourceRoot, 'index.html')))) throw new Error(`Design wiki index is missing: ${sourceRoot}`);

const resolvedPackageRoot = path.resolve(packageRoot);
if (!resolvedPackageRoot.startsWith(path.resolve(localRoot) + path.sep)) {
  throw new Error('Refusing to rebuild outside the local deployment directory.');
}
await rm(resolvedPackageRoot, { recursive: true, force: true });
await mkdir(siteRoot, { recursive: true });
await mkdir(publicRoot, { recursive: true });
await cp(sourceRoot, siteRoot, { recursive: true });

const transformedFiles = await walkFiles(siteRoot);
for (const file of transformedFiles) {
  const extension = path.extname(file).toLowerCase();
  if (!['.html', '.js'].includes(extension)) continue;
  let document = await readFile(file, 'utf8');
  document = document.replaceAll('index.html', config.entryFile);
  if (extension === '.html') {
    if (!document.includes('</head>')) throw new Error(`HTML head is incomplete: ${file}`);
    if (!document.includes('name="robots"')) document = document.replace('</head>', `${privacyMeta}\n</head>`);
  }
  await writeFile(file, document);
}

const originalEntry = path.join(siteRoot, 'index.html');
const privateEntry = path.join(siteRoot, config.entryFile);
await rename(originalEntry, privateEntry);
if (await exists(originalEntry)) throw new Error('The deployed wiki must not expose a directory index.');

const manifestPath = path.join(siteRoot, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
for (const entry of manifest.files) {
  if (entry.path === 'index.html') entry.path = config.entryFile;
  const contents = await readFile(path.join(siteRoot, entry.path));
  entry.bytes = contents.length;
  entry.sha256 = sha256(contents);
}
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const rootIndex = privateRootDocument('문서를 찾을 수 없습니다', '정확한 공유 주소를 다시 확인해 주세요.');
await writeFile(path.join(publicRoot, 'index.html'), rootIndex);
await writeFile(path.join(publicRoot, '404.html'), rootIndex);
await writeFile(path.join(publicRoot, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
await writeFile(path.join(publicRoot, '.nojekyll'), '');

const htmlFiles = (await walkFiles(siteRoot)).filter((file) => file.endsWith('.html'));
for (const file of htmlFiles) {
  const document = await readFile(file, 'utf8');
  if (!document.includes('noindex, nofollow, noarchive, nosnippet, noimageindex')) {
    throw new Error(`Privacy metadata is missing: ${file}`);
  }
}
if (htmlFiles.length < 80) throw new Error(`Unexpected HTML page count: ${htmlFiles.length}`);

await rm(archivePath, { force: true });
execFileSync('tar', ['-czf', archivePath, '-C', packageRoot, '.'], { stdio: 'inherit' });
const archive = await readFile(archivePath);
const encrypted = encryptBuffer(archive, config.siteKey);
await writeFile(bundlePath, encrypted);

const report = {
  repository: config.repository,
  entryUrl: `https://charismaplus.github.io/${config.sitePath}/${config.entryFile}`,
  rootUrl: 'https://charismaplus.github.io/',
  htmlPages: htmlFiles.length,
  bundleBytes: encrypted.length,
  bundleSha256: sha256(encrypted),
  generatedAt: new Date().toISOString(),
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(JSON.stringify({
  ok: true,
  repository: report.repository,
  entryUrl: report.entryUrl,
  htmlPages: report.htmlPages,
  bundleBytes: report.bundleBytes,
  bundleSha256: report.bundleSha256,
}, null, 2));
