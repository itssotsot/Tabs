# Tabs: notes for coding agents

Tabs is an Electron (castLabs build, with Widevine) browser for sharing tabs with friends. It was called Browserr until 0.2.0. See the README for features and setup.

## Releasing

Installed copies update from this repo's GitHub Releases (`src/main/updater.ts`, electron-updater). A release is:

```bash
git add -A && git commit -m "…"            # releases are built from what's pushed
npm version patch --no-git-tag-version     # or minor; the version must go up
git commit -am "Release x.y.z" && git push
npm run release                            # scripts/release.mjs, about 20–25 min
```

`scripts/release.mjs` refuses to run if the version is already released or HEAD isn't pushed to `origin/main`. It creates one **draft** release, runs `electron-builder --mac --win --publish always` into it, then publishes it.
- Don't let electron-builder create the release itself. The Mac and Windows uploads race to create it: in 0.2.0 one failed with "Published releases must have a valid tag", and the build stopped before writing `latest.yml` and `latest-mac.yml`.
- A release without both `latest*.yml` files is invisible to the updater. After releasing, check that the release has them.
- Publishing is outward-facing: only release when the user asks.

How updates behave:
- **Windows:** downloads in the background. The toolbar's **Update** button calls `quitAndInstall`; otherwise the update installs when the app quits.
- **Mac:** no Developer ID, so Squirrel.Mac can't swap the app. The updater downloads `Tabs-<version>-<arch>.dmg` itself and checks its sha512 against `latest-mac.yml`. **Update** then opens the DMG and quits, and the user drag-replaces the app. The DMG's `-<arch>` suffix (the `mac.artifactName` setting) is what the updater matches on.
- Dev builds and `--profile=…` copies never check for updates.
- Since 0.3.1, releases are Apple Silicon Mac + Intel/AMD Windows only (`electron-builder.yml` targets). Intel Macs find no `-x64.dmg` and stay on 0.3.0; Windows ARM installs update to the x64 build.

## Names: what's "Tabs" and what stays "browserr"

User-facing text, `productName`, the app ID `com.itssotsot.tabs` and the installers are **Tabs**. These deliberately stay **browserr**:
- the `browserr://` internal scheme (it's the UI's origin; changing it signs everyone out of Firebase and drops localStorage);
- `window.browserr` / `BrowserrAPI`, localStorage keys and `BROWSERR_*` env vars;
- the Firebase project `browserr-share`.

On first launch, `src/main/index.ts` moves the old `Browserr[ (profile)]` data folder to `Tabs[ (profile)]`.

"Tabs" is also a common word, so don't start UI sentences with "Tabs" meaning browser tabs ("Pinned tabs, tabs playing audio…", not "Tabs playing audio…").

## Building and running

- `npm run typecheck` before committing. `npm run dev` for development.
- Test in a throwaway profile (`BROWSERR_PROFILE=<name> npm run dev`) so the user's data isn't touched.
- The user runs the packaged app from `dist/mac-arm64/Tabs.app`. Don't rebuild into `dist/` while it's open; for test builds use `-c.directories.output=/tmp/…`.
- Firebase: always target `browserr-share` explicitly (`--project browserr-share`). Another project is the CLI's global default.
- The Firestore emulator runs on port 8181 (8080 belongs to another project).
