# Harbor Realm unlisted Pages deployment

This public repository stores encrypted static-site bundles and the minimum GitHub Actions code required to publish them. It must never contain a plaintext wiki, a complete share URL, a hidden path, or a decryption key.

GitHub Pages is public hosting. Random paths, non-index entry files, crawler directives, and encrypted source bundles reduce accidental discovery; they do not provide visitor authentication. Anyone who obtains a complete deployed URL can open and reshare it.

## Bundles

| Bundle | Local source | Local packager | GitHub secrets |
|---|---|---|---|
| Game design wiki | Multi-page static site | `prepare-local.mjs` | `SITE_KEY`, `SITE_PATH` |
| Player wiki | Standalone single HTML | `prepare-player-local.mjs` | `PLAYER_SITE_KEY`, `PLAYER_SITE_PATH` |
| KIOK | Astro multi-page static site | `prepare-kiok-local.mjs` | `KIOK_SITE_KEY`, `KIOK_SITE_PATH` |

The workflow decrypts all three bundles and assembles them into one Pages artifact. This is required because every Pages deployment replaces the complete published snapshot. The design wiki root files remain authoritative for the neutral root page, custom 404 page, and global `robots.txt`.

## Private local state

All keys, hidden paths, entry filenames, and complete URLs live under `.local/`, which is ignored by Git:

- `.local/deployment.json` and `.local/deployment-report.json`
- `.local/player-deployment.json` and `.local/player-deployment-report.json`
- `.local/kiok-deployment.json` and `.local/kiok-deployment-report.json`
- temporary plaintext packages and archives

Do not print these files in CI, attach them to an issue, or commit them to any repository. Keep a separate encrypted backup of the local configurations; GitHub Actions secrets cannot be read back after registration.

## Prepare locally

Build and verify each source in its owning project first. Then refresh only the bundle whose source changed.

```powershell
node .\prepare-local.mjs --source D:\NewProj\HarborRealmGame\docs\design-wiki\site
node .\prepare-player-local.mjs --source D:\NewProj\HarborRealmGame\docs\wiki\HarborRealm_Wiki.html
node .\prepare-kiok-local.mjs --source D:\NewProj\kiok-site\dist
```

The player packager:

- reuses its existing local key, hidden path, and random entry filename on later updates;
- injects crawler blocking, `no-referrer`, and a restrictive static-page CSP;
- rejects `index.html` dependencies, unresolved asset markers, automatic network APIs, and non-embedded resources;
- packages exactly one hardened HTML file without a directory index;
- writes only `player.bundle.enc` outside `.local/`;
- prints a bundle digest and a private report-file location, never the share URL or secret path.

The KIOK packager applies the same crawler and referrer protections to every HTML page while preserving its local styles, fonts, and multi-page navigation. It removes canonical and localhost metadata, scopes root-absolute links to the private path, renames the root `index.html` to a random entry filename, rejects symbolic links and oversized packages, and stores only `kiok.bundle.enc` outside `.local/`.

Run the local package tests without producing a repository bundle:

```powershell
node --test .\tests\prepare-player-local.test.mjs
node --test .\tests\prepare-kiok-local.test.mjs
```

## Register secrets and deploy

Register all six repository Actions secrets through GitHub's secret UI. Copy values from the corresponding private local configuration without echoing them into a terminal transcript. Do not put an entry filename in a GitHub secret: it is already protected inside its encrypted bundle.

Before pushing, confirm that all three encrypted bundles exist. Commit only reviewed scripts, the workflow, and encrypted bundles. The workflow validates key length, hidden-path format, path separation, archive traversal, symlinks, non-index entries, and privacy metadata before uploading.

The successful or failed deployment path always reaches the cleanup job after the deploy job settles. The Pages artifact is also configured for one-day retention as a fallback. A manually cancelled GitHub Actions run can still interrupt cleanup, so check the run's artifact list before considering a deployment complete.

## Live verification

After each deployment, verify without recording private URLs in tracked files or public logs:

1. The root shows only the neutral document-not-found page.
2. The design wiki's existing complete URL still returns HTTP 200.
3. The player wiki's complete URL returns HTTP 200.
4. KIOK's complete random-entry URL returns HTTP 200 and its internal wiki navigation stays inside the same hidden path.
5. Each hidden directory without its random entry filename returns HTTP 404.
6. Root `robots.txt` contains `User-agent: *` and `Disallow: /`.
7. All three sites contain crawler-blocking metadata and `referrer=no-referrer`.
8. Internal navigation, search, scroll effects, reduced motion, and responsive layouts work in installed Chrome with no console or unintended network errors.
9. The workflow run retains no `github-pages` artifact.
10. Git history contains no plaintext page content, key, hidden path, or complete share URL.

If a complete URL is exposed, generate a new local hidden path and entry filename, replace the matching GitHub path secret, redeploy, and stop sharing the old URL. Search directives and URL rotation are not substitutes for authenticated hosting when the documents require real confidentiality.
