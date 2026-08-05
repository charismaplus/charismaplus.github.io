import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { decryptBuffer } from '../decrypt.mjs';
import {
  hardenKiokHtml,
  prepareKiokBundle,
  validateHardenedKiokHtml,
} from '../prepare-kiok-local.mjs';

const sampleHtml = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="http://localhost:4321/">
  <link rel="icon" href="/favicon.svg">
  <link rel="stylesheet" href="/_astro/site.css">
  <title>기억</title>
</head>
<body><a href="/">홈</a><a href="/wiki">위키</a><a href="https://example.com/reference">참고</a></body>
</html>`;

test('KIOK privacy hardening scopes root links and removes canonical metadata', () => {
  const sitePath = `kiok-${'a'.repeat(40)}`;
  const entryFile = `memory-map-${'b'.repeat(32)}.html`;
  const hardened = hardenKiokHtml(sampleHtml, sitePath, entryFile);
  validateHardenedKiokHtml(hardened, sitePath);
  assert.doesNotMatch(hardened, /localhost|rel="canonical"/i);
  assert.match(hardened, new RegExp(`href="/${sitePath}/${entryFile}"`));
  assert.match(hardened, new RegExp(`href="/${sitePath}/wiki"`));
  assert.match(hardened, new RegExp(`href="/${sitePath}/_astro/site.css"`));
  assert.match(hardened, /href="https:\/\/example\.com\/reference"/);
  assert.match(hardened, /noindex, nofollow, noarchive, nosnippet, noimageindex/);
  assert.match(hardened, /connect-src 'none'/);
});

test('KIOK validation rejects unscoped root references and automatic network APIs', () => {
  const sitePath = `kiok-${'a'.repeat(40)}`;
  const entryFile = `memory-map-${'b'.repeat(32)}.html`;
  const hardened = hardenKiokHtml(sampleHtml, sitePath, entryFile);
  assert.throws(
    () => validateHardenedKiokHtml(hardened.replace(`/${sitePath}/wiki`, '/wiki'), sitePath),
    /unscoped root reference/,
  );
  assert.throws(
    () => validateHardenedKiokHtml(hardened.replace('</body>', '<script>fetch("/secret")</script></body>'), sitePath),
    /automatic network request/,
  );
});

test('KIOK bundle keeps secrets local and publishes a non-index multi-page site', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiok-pages-'));
  try {
    const sourceRoot = path.join(root, 'source');
    const repositoryRoot = path.join(root, 'repository');
    const localRoot = path.join(repositoryRoot, '.local');
    const bundlePath = path.join(repositoryRoot, 'kiok.bundle.enc');
    await mkdir(path.join(sourceRoot, '_astro'), { recursive: true });
    await mkdir(path.join(sourceRoot, 'wiki'), { recursive: true });
    await mkdir(repositoryRoot, { recursive: true });
    await writeFile(path.join(sourceRoot, 'index.html'), sampleHtml, 'utf8');
    await writeFile(path.join(sourceRoot, 'wiki', 'index.html'), sampleHtml.replace('<title>기억</title>', '<title>기억 위키</title>'), 'utf8');
    await writeFile(path.join(sourceRoot, '_astro', 'site.css'), '@font-face{src:url(/_astro/site.woff2)}', 'utf8');
    await writeFile(path.join(sourceRoot, '_astro', 'site.woff2'), Buffer.from('font-placeholder'));
    await writeFile(path.join(sourceRoot, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8');

    const first = await prepareKiokBundle({
      sourceRoot,
      repositoryRoot,
      localRoot,
      bundlePath,
      repository: 'example.invalid',
      baseUrl: 'https://example.invalid',
    });
    assert.match(first.config.sitePath, /^kiok-[a-f0-9]{40}$/);
    assert.match(first.config.entryFile, /^memory-map-[a-f0-9]{32}\.html$/);
    assert.ok(first.config.siteKey.length >= 48);
    assert.equal(first.report.entryUrl, `https://example.invalid/${first.config.sitePath}/${first.config.entryFile}`);
    assert.equal(first.report.htmlPages, 2);

    const encrypted = await readFile(bundlePath);
    assert.equal(encrypted.subarray(0, 5).toString('ascii'), 'HRPW1');
    assert.throws(() => decryptBuffer(encrypted, 'incorrect-key-material-that-is-long-enough'));

    const archivePath = path.join(root, 'verified.tar.gz');
    const extractRoot = path.join(root, 'verified');
    await mkdir(extractRoot, { recursive: true });
    await writeFile(archivePath, decryptBuffer(encrypted, first.config.siteKey));
    execFileSync('tar', ['-xzf', archivePath, '-C', extractRoot], { stdio: 'ignore' });
    const siteFiles = await readdir(path.join(extractRoot, 'site'));
    assert.ok(siteFiles.includes(first.config.entryFile));
    assert.ok(siteFiles.includes('wiki'));
    assert.ok(siteFiles.includes('_astro'));
    assert.ok(!siteFiles.includes('index.html'));

    const deployedEntry = await readFile(path.join(extractRoot, 'site', first.config.entryFile), 'utf8');
    const deployedWiki = await readFile(path.join(extractRoot, 'site', 'wiki', 'index.html'), 'utf8');
    const deployedCss = await readFile(path.join(extractRoot, 'site', '_astro', 'site.css'), 'utf8');
    for (const document of [deployedEntry, deployedWiki]) {
      assert.match(document, /name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex"/);
      assert.doesNotMatch(document, /localhost|rel="canonical"/i);
    }
    assert.match(deployedCss, new RegExp(`url\\(/${first.config.sitePath}/_astro/site\\.woff2\\)`));

    const second = await prepareKiokBundle({
      sourceRoot,
      repositoryRoot,
      localRoot,
      bundlePath,
      repository: 'example.invalid',
      baseUrl: 'https://example.invalid',
    });
    assert.equal(second.config.siteKey, first.config.siteKey);
    assert.equal(second.config.sitePath, first.config.sitePath);
    assert.equal(second.config.entryFile, first.config.entryFile);
    assert.equal(second.report.deployedSha256, first.report.deployedSha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
