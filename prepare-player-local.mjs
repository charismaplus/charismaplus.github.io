import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encryptBuffer } from './decrypt.mjs';

const defaultRepositoryRoot = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPOSITORY = 'charismaplus.github.io';
const DEFAULT_BASE_URL = 'https://charismaplus.github.io';
const SITE_PATH_PATTERN = /^guide-[a-f0-9]{40}$/;
const ENTRY_FILE_PATTERN = /^captains-log-[a-f0-9]{32}\.html$/;

export const PLAYER_PRIVACY_META = [
  '  <meta name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex">',
  '  <meta name="googlebot" content="noindex, nofollow, noarchive, nosnippet, noimageindex">',
  '  <meta name="bingbot" content="noindex, nofollow, noarchive, nosnippet, noimageindex">',
  '  <meta name="referrer" content="no-referrer">',
  '  <meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; media-src data:; font-src data:; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'; connect-src \'none\'; worker-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'; manifest-src \'none\'">',
].join('\n');

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

function assertInside(parent, target, label) {
  const resolvedParent = path.resolve(parent);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget === resolvedParent || !resolvedTarget.startsWith(`${resolvedParent}${path.sep}`)) {
    throw new Error(`Refusing to use ${label} outside its private working directory.`);
  }
}

export function validateStandalonePlayerHtml(document) {
  if (typeof document !== 'string' || document.length === 0) {
    throw new Error('Player wiki HTML is empty.');
  }
  if (!/<!doctype\s+html/i.test(document) || !/<html\b/i.test(document)) {
    throw new Error('Player wiki must be a complete HTML document.');
  }
  if (!/<head\b[^>]*>/i.test(document) || !/<\/head>/i.test(document)) {
    throw new Error('Player wiki head is incomplete.');
  }
  if (!/<body\b[^>]*>/i.test(document) || !/<\/body>/i.test(document)) {
    throw new Error('Player wiki body is incomplete.');
  }
  if (/index\.html/i.test(document)) {
    throw new Error('Player wiki must not depend on an index.html entry point.');
  }
  if (/\{\{asset:[^}]+\}\}/i.test(document)) {
    throw new Error('Player wiki contains an unresolved asset marker.');
  }
  if (/<base\b/i.test(document)) {
    throw new Error('Player wiki must not define a base URL.');
  }
  if (/<meta\b(?=[^>]*http-equiv\s*=\s*["']?refresh["']?)[^>]*>/i.test(document)) {
    throw new Error('Player wiki must not contain a meta refresh.');
  }
  if (/<link\b(?=[^>]*rel\s*=\s*["'][^"']*canonical)[^>]*>/i.test(document)
    || /<meta\b(?=[^>]*(?:property|name)\s*=\s*["'](?:og:url|twitter:url)["'])[^>]*>/i.test(document)) {
    throw new Error('Player wiki must not embed a canonical share URL.');
  }

  const resourceAttributes = [
    ...document.matchAll(/<(?:img|script|iframe|audio|video|source|track|embed|input)\b[^>]*\b(?:src|poster)\s*=\s*["']([^"']+)["']/gi),
    ...document.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi),
  ];
  for (const match of resourceAttributes) {
    if (!match[1].trim().toLowerCase().startsWith('data:')) {
      throw new Error(`Player wiki contains a non-embedded resource: ${match[1]}`);
    }
  }

  for (const match of document.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
    const value = match[1].trim().toLowerCase();
    if (!value.startsWith('data:') && !value.startsWith('#') && !value.startsWith('%23')) {
      throw new Error(`Player wiki CSS contains a non-embedded resource: ${match[1]}`);
    }
  }
  if (/@import\b/i.test(document)) {
    throw new Error('Player wiki CSS must not import an external stylesheet.');
  }
  if (/\b(?:fetch|xmlhttprequest|websocket|eventsource|sendbeacon)\s*\(/i.test(document)
    || /navigator\.serviceWorker/i.test(document)) {
    throw new Error('Player wiki must not initiate an external network request.');
  }
}

export function hardenPlayerHtml(document) {
  validateStandalonePlayerHtml(document);
  const withoutPrivacyMeta = document
    .replace(/^[ \t]*<meta\b(?=[^>]*\bname\s*=\s*["'](?:robots|googlebot|bingbot|referrer)["'])[^>]*>[ \t]*(?:\r?\n)?/gim, '')
    .replace(/^[ \t]*<meta\b(?=[^>]*\bhttp-equiv\s*=\s*["']Content-Security-Policy["'])[^>]*>[ \t]*(?:\r?\n)?/gim, '');
  const hardened = withoutPrivacyMeta.replace(/<\/head>/i, `${PLAYER_PRIVACY_META}\n</head>`);
  validateStandalonePlayerHtml(hardened);
  if ((hardened.match(/name="robots"/g) ?? []).length !== 1
    || (hardened.match(/http-equiv="Content-Security-Policy"/g) ?? []).length !== 1) {
    throw new Error('Player wiki privacy metadata is not unique.');
  }
  return hardened;
}

async function loadOrCreateConfig(configPath, localRoot, repository) {
  const config = await exists(configPath)
    ? JSON.parse(await readFile(configPath, 'utf8'))
    : { createdAt: new Date().toISOString() };
  config.repository = repository;
  if (!config.siteKey || config.siteKey.length < 48) {
    config.siteKey = randomBytes(48).toString('base64url');
  }
  if (!SITE_PATH_PATTERN.test(config.sitePath ?? '')) {
    config.sitePath = `guide-${randomBytes(20).toString('hex')}`;
  }
  if (!ENTRY_FILE_PATTERN.test(config.entryFile ?? '')) {
    config.entryFile = `captains-log-${randomBytes(16).toString('hex')}.html`;
  }
  await mkdir(localRoot, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return config;
}

export async function preparePlayerBundle({
  sourcePath,
  repositoryRoot = defaultRepositoryRoot,
  localRoot = path.join(repositoryRoot, '.local'),
  bundlePath = path.join(repositoryRoot, 'player.bundle.enc'),
  repository = DEFAULT_REPOSITORY,
  baseUrl = DEFAULT_BASE_URL,
} = {}) {
  if (!sourcePath) throw new Error('A player wiki source file is required.');
  const resolvedSource = path.resolve(sourcePath);
  const sourceInfo = await stat(resolvedSource).catch(() => null);
  if (!sourceInfo?.isFile() || path.extname(resolvedSource).toLowerCase() !== '.html') {
    throw new Error(`Player wiki source is not an HTML file: ${resolvedSource}`);
  }

  const resolvedLocalRoot = path.resolve(localRoot);
  const configPath = path.join(resolvedLocalRoot, 'player-deployment.json');
  const packageRoot = path.join(resolvedLocalRoot, 'player-package');
  const siteRoot = path.join(packageRoot, 'site');
  const archivePath = path.join(resolvedLocalRoot, 'player-deployment.tar.gz');
  const reportPath = path.join(resolvedLocalRoot, 'player-deployment-report.json');
  const bundleTempPath = `${path.resolve(bundlePath)}.tmp`;
  assertInside(resolvedLocalRoot, configPath, 'configuration');
  assertInside(resolvedLocalRoot, packageRoot, 'package');
  assertInside(resolvedLocalRoot, archivePath, 'archive');
  assertInside(resolvedLocalRoot, reportPath, 'report');

  const config = await loadOrCreateConfig(configPath, resolvedLocalRoot, repository);
  if (!SITE_PATH_PATTERN.test(config.sitePath)) throw new Error('Local player sitePath is invalid.');
  if (!ENTRY_FILE_PATTERN.test(config.entryFile)) throw new Error('Local player entryFile is invalid.');
  if (!config.siteKey || config.siteKey.length < 48) throw new Error('Local player siteKey is invalid.');

  const source = await readFile(resolvedSource, 'utf8');
  const hardened = hardenPlayerHtml(source);

  await rm(packageRoot, { recursive: true, force: true });
  await mkdir(siteRoot, { recursive: true });
  const privateEntryPath = path.join(siteRoot, config.entryFile);
  await writeFile(privateEntryPath, hardened, 'utf8');
  if (await exists(path.join(siteRoot, 'index.html'))) {
    throw new Error('The deployed player wiki must not expose a directory index.');
  }

  await rm(archivePath, { force: true });
  execFileSync('tar', ['-czf', archivePath, '-C', packageRoot, '.'], { stdio: 'ignore' });
  const archive = await readFile(archivePath);
  const encrypted = encryptBuffer(archive, config.siteKey);
  await writeFile(bundleTempPath, encrypted);
  await rename(bundleTempPath, path.resolve(bundlePath));

  const report = {
    repository: config.repository,
    entryUrl: `${baseUrl.replace(/\/$/, '')}/${config.sitePath}/${config.entryFile}`,
    sourceSha256: sha256(Buffer.from(source)),
    deployedHtmlSha256: sha256(Buffer.from(hardened)),
    bundleBytes: encrypted.length,
    bundleSha256: sha256(encrypted),
    generatedAt: new Date().toISOString(),
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });

  return {
    config,
    report,
    paths: { archivePath, bundlePath: path.resolve(bundlePath), configPath, packageRoot, reportPath },
  };
}

function readFlag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function runCli() {
  const sourcePath = readFlag('--source');
  if (!sourcePath) {
    throw new Error('Usage: node prepare-player-local.mjs --source <standalone-player-wiki.html>');
  }
  const result = await preparePlayerBundle({ sourcePath });
  console.log(JSON.stringify({
    ok: true,
    bundleBytes: result.report.bundleBytes,
    bundleSha256: result.report.bundleSha256,
    reportFile: path.relative(defaultRepositoryRoot, result.paths.reportPath),
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
