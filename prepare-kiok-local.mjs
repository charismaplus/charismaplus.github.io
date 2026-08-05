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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encryptBuffer } from './decrypt.mjs';

const defaultRepositoryRoot = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPOSITORY = 'charismaplus.github.io';
const DEFAULT_BASE_URL = 'https://charismaplus.github.io';
const SITE_PATH_PATTERN = /^kiok-[a-f0-9]{40}$/;
const ENTRY_FILE_PATTERN = /^memory-map-[a-f0-9]{32}\.html$/;
const MAX_FILES = 5_000;
const MAX_BYTES = 64 * 1024 * 1024;

export const KIOK_PRIVACY_META = [
  '  <meta name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex">',
  '  <meta name="googlebot" content="noindex, nofollow, noarchive, nosnippet, noimageindex">',
  '  <meta name="bingbot" content="noindex, nofollow, noarchive, nosnippet, noimageindex">',
  '  <meta name="referrer" content="no-referrer">',
  '  <meta http-equiv="Content-Security-Policy" content="default-src \'self\'; img-src \'self\' data:; media-src \'self\' data:; font-src \'self\' data:; style-src \'self\' \'unsafe-inline\'; script-src \'self\' \'unsafe-inline\'; connect-src \'none\'; worker-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'; manifest-src \'self\'">',
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

async function walkFiles(directory, root = directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${path.relative(root, absolute)}`);
    if (entry.isDirectory()) output.push(...await walkFiles(absolute, root));
    else if (entry.isFile()) output.push(absolute);
    else throw new Error(`Unsupported static-site entry: ${path.relative(root, absolute)}`);
  }
  return output;
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
    config.sitePath = `kiok-${randomBytes(20).toString('hex')}`;
  }
  if (!ENTRY_FILE_PATTERN.test(config.entryFile ?? '')) {
    config.entryFile = `memory-map-${randomBytes(16).toString('hex')}.html`;
  }
  await mkdir(localRoot, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return config;
}

function removeDiscoverabilityMetadata(document) {
  return document
    .replace(/<meta\b(?=[^>]*\bname\s*=\s*["'](?:robots|googlebot|bingbot|referrer)["'])[^>]*>[ \t]*(?:\r?\n)?/gi, '')
    .replace(/<meta\b(?=[^>]*\bhttp-equiv\s*=\s*["']Content-Security-Policy["'])[^>]*>[ \t]*(?:\r?\n)?/gi, '')
    .replace(/<link\b(?=[^>]*\brel\s*=\s*["'][^"']*canonical[^"']*["'])[^>]*>[ \t]*(?:\r?\n)?/gi, '')
    .replace(/<meta\b(?=[^>]*(?:property|name)\s*=\s*["'](?:og:url|twitter:url)["'])[^>]*>[ \t]*(?:\r?\n)?/gi, '');
}

function rewriteRootAbsoluteReferences(document, sitePath, entryFile) {
  const prefix = `/${sitePath}`;
  const rootEntry = `${prefix}/${entryFile}`;
  const rewrite = (_match, start, value, end) => {
    if (value === '' || value.startsWith('?') || value.startsWith('#')) {
      return `${start}${rootEntry}${value}${end}`;
    }
    return `${start}${prefix}/${value}${end}`;
  };
  return document
    .replace(/(\b(?:href|src|poster|action)\s*=\s*["'])\/(?!\/)([^"']*)(["'])/gi, rewrite)
    .replace(/url\(\s*(["']?)\/(?!\/)/gi, `url($1${prefix}/`);
}

export function hardenKiokHtml(document, sitePath, entryFile) {
  if (typeof document !== 'string' || !document.includes('</head>')) {
    throw new Error('KIOK HTML head is incomplete.');
  }
  let hardened = removeDiscoverabilityMetadata(document);
  hardened = rewriteRootAbsoluteReferences(hardened, sitePath, entryFile);
  hardened = hardened.replace(/<\/head>/i, `${KIOK_PRIVACY_META}\n</head>`);
  validateHardenedKiokHtml(hardened, sitePath);
  return hardened;
}

export function validateHardenedKiokHtml(document, sitePath) {
  if (!SITE_PATH_PATTERN.test(sitePath)) throw new Error('KIOK sitePath is invalid.');
  if (!/<!doctype\s+html/i.test(document) || !/<html\b/i.test(document)) {
    throw new Error('KIOK page must be a complete HTML document.');
  }
  if (/<base\b/i.test(document)) throw new Error('KIOK pages must not define a base URL.');
  if (/\blocalhost(?::\d+)?\b/i.test(document)) throw new Error('KIOK page contains a localhost URL.');
  if (/<link\b(?=[^>]*\brel\s*=\s*["'][^"']*canonical)/i.test(document)
    || /<meta\b(?=[^>]*(?:property|name)\s*=\s*["'](?:og:url|twitter:url)["'])/i.test(document)) {
    throw new Error('KIOK page contains a discoverable canonical URL.');
  }
  if ((document.match(/name="robots"/g) ?? []).length !== 1
    || (document.match(/name="googlebot"/g) ?? []).length !== 1
    || (document.match(/name="bingbot"/g) ?? []).length !== 1
    || (document.match(/name="referrer"/g) ?? []).length !== 1
    || (document.match(/http-equiv="Content-Security-Policy"/g) ?? []).length !== 1) {
    throw new Error('KIOK privacy metadata is missing or duplicated.');
  }
  if (!document.includes('noindex, nofollow, noarchive, nosnippet, noimageindex')
    || !document.includes("connect-src 'none'")) {
    throw new Error('KIOK crawler or network blocking is incomplete.');
  }
  for (const match of document.matchAll(/\b(?:href|src|poster|action)\s*=\s*["'](\/[^/][^"']*)["']/gi)) {
    if (!match[1].startsWith(`/${sitePath}/`)) {
      throw new Error(`KIOK page contains an unscoped root reference: ${match[1]}`);
    }
  }
  for (const match of document.matchAll(/url\(\s*["']?(\/[^/][^"')]+)["']?\s*\)/gi)) {
    if (!match[1].startsWith(`/${sitePath}/`)) {
      throw new Error(`KIOK CSS contains an unscoped root reference: ${match[1]}`);
    }
  }
  if (/\b(?:fetch|xmlhttprequest|websocket|eventsource|sendbeacon)\s*\(/i.test(document)
    || /navigator\.serviceWorker/i.test(document)) {
    throw new Error('KIOK page initiates an automatic network request.');
  }
}

async function directoryDigest(root, files) {
  const records = [];
  for (const file of [...files].sort()) {
    const contents = await readFile(file);
    records.push(`${path.relative(root, file).replaceAll(path.sep, '/')}\0${contents.length}\0${sha256(contents)}`);
  }
  return sha256(Buffer.from(records.join('\n')));
}

export async function prepareKiokBundle({
  sourceRoot,
  repositoryRoot = defaultRepositoryRoot,
  localRoot = path.join(repositoryRoot, '.local'),
  bundlePath = path.join(repositoryRoot, 'kiok.bundle.enc'),
  repository = DEFAULT_REPOSITORY,
  baseUrl = DEFAULT_BASE_URL,
} = {}) {
  if (!sourceRoot) throw new Error('A KIOK static-site directory is required.');
  const resolvedSource = path.resolve(sourceRoot);
  const sourceInfo = await stat(resolvedSource).catch(() => null);
  if (!sourceInfo?.isDirectory() || !(await exists(path.join(resolvedSource, 'index.html')))) {
    throw new Error(`KIOK static-site index is missing: ${resolvedSource}`);
  }
  const sourceFiles = await walkFiles(resolvedSource);
  const sourceBytes = (await Promise.all(sourceFiles.map(async (file) => (await stat(file)).size)))
    .reduce((total, size) => total + size, 0);
  if (sourceFiles.length < 2 || sourceFiles.length > MAX_FILES) {
    throw new Error(`Unexpected KIOK static-site file count: ${sourceFiles.length}`);
  }
  if (sourceBytes <= 0 || sourceBytes > MAX_BYTES) {
    throw new Error(`Unexpected KIOK static-site byte size: ${sourceBytes}`);
  }

  const resolvedLocalRoot = path.resolve(localRoot);
  const configPath = path.join(resolvedLocalRoot, 'kiok-deployment.json');
  const packageRoot = path.join(resolvedLocalRoot, 'kiok-package');
  const siteRoot = path.join(packageRoot, 'site');
  const archivePath = path.join(resolvedLocalRoot, 'kiok-deployment.tar.gz');
  const reportPath = path.join(resolvedLocalRoot, 'kiok-deployment-report.json');
  const bundleTempPath = `${path.resolve(bundlePath)}.tmp`;
  for (const [target, label] of [
    [configPath, 'configuration'], [packageRoot, 'package'], [archivePath, 'archive'], [reportPath, 'report'],
  ]) assertInside(resolvedLocalRoot, target, label);

  const config = await loadOrCreateConfig(configPath, resolvedLocalRoot, repository);
  if (!SITE_PATH_PATTERN.test(config.sitePath)) throw new Error('Local KIOK sitePath is invalid.');
  if (!ENTRY_FILE_PATTERN.test(config.entryFile)) throw new Error('Local KIOK entryFile is invalid.');
  if (!config.siteKey || config.siteKey.length < 48) throw new Error('Local KIOK siteKey is invalid.');

  await rm(packageRoot, { recursive: true, force: true });
  await mkdir(siteRoot, { recursive: true });
  await cp(resolvedSource, siteRoot, { recursive: true });

  for (const file of await walkFiles(siteRoot)) {
    const extension = path.extname(file).toLowerCase();
    if (extension === '.html') {
      const document = await readFile(file, 'utf8');
      await writeFile(file, hardenKiokHtml(document, config.sitePath, config.entryFile), 'utf8');
    } else if (extension === '.css') {
      const stylesheet = await readFile(file, 'utf8');
      await writeFile(file, rewriteRootAbsoluteReferences(stylesheet, config.sitePath, config.entryFile), 'utf8');
    }
  }
  await writeFile(path.join(siteRoot, 'robots.txt'), 'User-agent: *\nDisallow: /\n', 'utf8');

  const originalEntry = path.join(siteRoot, 'index.html');
  const privateEntry = path.join(siteRoot, config.entryFile);
  await rename(originalEntry, privateEntry);
  if (await exists(originalEntry)) throw new Error('The deployed KIOK site must not expose a root index.');

  const deployedFiles = await walkFiles(siteRoot);
  const htmlFiles = deployedFiles.filter((file) => path.extname(file).toLowerCase() === '.html');
  if (htmlFiles.length < 2) throw new Error(`Unexpected KIOK HTML page count: ${htmlFiles.length}`);
  for (const file of htmlFiles) {
    validateHardenedKiokHtml(await readFile(file, 'utf8'), config.sitePath);
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
    sourceSha256: await directoryDigest(resolvedSource, sourceFiles),
    deployedSha256: await directoryDigest(siteRoot, deployedFiles),
    fileCount: deployedFiles.length,
    htmlPages: htmlFiles.length,
    sourceBytes,
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
  const sourceRoot = readFlag('--source');
  if (!sourceRoot) throw new Error('Usage: node prepare-kiok-local.mjs --source <kiok-static-site-directory>');
  const result = await prepareKiokBundle({ sourceRoot });
  console.log(JSON.stringify({
    ok: true,
    fileCount: result.report.fileCount,
    htmlPages: result.report.htmlPages,
    bundleBytes: result.report.bundleBytes,
    bundleSha256: result.report.bundleSha256,
    reportFile: path.relative(defaultRepositoryRoot, result.paths.reportPath),
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
