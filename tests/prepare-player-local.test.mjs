import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { decryptBuffer } from '../decrypt.mjs';
import {
  hardenPlayerHtml,
  preparePlayerBundle,
  validateStandalonePlayerHtml,
} from '../prepare-player-local.mjs';

const sampleHtml = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="robots" content="index, follow">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3C/svg%3E">
  <style>body{background-image:url("data:image/svg+xml,%3Csvg/%3E")}</style>
  <title>선장 안내서</title>
</head>
<body><main><h1>항구에서 세계로</h1><a href="#guide">안내 보기</a></main><script>document.body.dataset.ready='true';</script></body>
</html>`;

test('privacy hardening is deterministic and replaces conflicting metadata', () => {
  const first = hardenPlayerHtml(sampleHtml);
  const second = hardenPlayerHtml(first);
  assert.equal(second, first);
  assert.equal((first.match(/name="robots"/g) ?? []).length, 1);
  assert.equal((first.match(/name="googlebot"/g) ?? []).length, 1);
  assert.equal((first.match(/name="bingbot"/g) ?? []).length, 1);
  assert.equal((first.match(/name="referrer"/g) ?? []).length, 1);
  assert.equal((first.match(/Content-Security-Policy/g) ?? []).length, 1);
  assert.match(first, /noindex, nofollow, noarchive, nosnippet, noimageindex/);
  assert.match(first, /connect-src 'none'/);
});

test('standalone validation rejects discoverable or network-dependent documents', () => {
  assert.throws(
    () => validateStandalonePlayerHtml(sampleHtml.replace('</body>', '<img src="asset.webp"></body>')),
    /non-embedded resource/,
  );
  assert.throws(
    () => validateStandalonePlayerHtml(sampleHtml.replace('</body>', '<script>fetch("https://example.invalid")</script></body>')),
    /external network request/,
  );
  assert.throws(
    () => validateStandalonePlayerHtml(sampleHtml.replace('</body>', '<a href="index.html">home</a></body>')),
    /index\.html/,
  );
  assert.throws(
    () => validateStandalonePlayerHtml(sampleHtml.replace('</head>', '<link rel="canonical" href="https://example.invalid/guide"></head>')),
    /canonical share URL/,
  );
});

test('player bundle keeps secrets local and contains one non-index hardened entry', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'harbor-player-pages-'));
  try {
    const sourcePath = path.join(root, 'player.html');
    const repositoryRoot = path.join(root, 'repository');
    const localRoot = path.join(repositoryRoot, '.local');
    const bundlePath = path.join(repositoryRoot, 'player.bundle.enc');
    await mkdir(repositoryRoot, { recursive: true });
    await writeFile(sourcePath, sampleHtml, 'utf8');

    const first = await preparePlayerBundle({
      sourcePath,
      repositoryRoot,
      localRoot,
      bundlePath,
      repository: 'example.invalid',
      baseUrl: 'https://example.invalid',
    });
    assert.match(first.config.sitePath, /^guide-[a-f0-9]{40}$/);
    assert.match(first.config.entryFile, /^captains-log-[a-f0-9]{32}\.html$/);
    assert.ok(first.config.siteKey.length >= 48);
    assert.equal(first.report.entryUrl, `https://example.invalid/${first.config.sitePath}/${first.config.entryFile}`);

    const encrypted = await readFile(bundlePath);
    assert.equal(encrypted.subarray(0, 5).toString('ascii'), 'HRPW1');
    assert.throws(() => decryptBuffer(encrypted, 'incorrect-key-material-that-is-long-enough'));

    const archivePath = path.join(root, 'verified.tar.gz');
    const extractRoot = path.join(root, 'verified');
    await mkdir(extractRoot, { recursive: true });
    await writeFile(archivePath, decryptBuffer(encrypted, first.config.siteKey));
    execFileSync('tar', ['-xzf', archivePath, '-C', extractRoot], { stdio: 'ignore' });
    const siteFiles = await readdir(path.join(extractRoot, 'site'));
    assert.deepEqual(siteFiles, [first.config.entryFile]);
    assert.ok(!siteFiles.includes('index.html'));
    const deployed = await readFile(path.join(extractRoot, 'site', first.config.entryFile), 'utf8');
    assert.match(deployed, /name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex"/);
    assert.match(deployed, /Content-Security-Policy/);

    const second = await preparePlayerBundle({
      sourcePath,
      repositoryRoot,
      localRoot,
      bundlePath,
      repository: 'example.invalid',
      baseUrl: 'https://example.invalid',
    });
    assert.equal(second.config.siteKey, first.config.siteKey);
    assert.equal(second.config.sitePath, first.config.sitePath);
    assert.equal(second.config.entryFile, first.config.entryFile);
    assert.equal(second.report.deployedHtmlSha256, first.report.deployedHtmlSha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
