# Tabs: notes for coding agents

Tabs is an Electron (castLabs build, with Widevine) browser for sharing tabs with friends. It was called Browserr at first. Versions restarted at 0.0.1 on 2026-09-28, when the earlier test releases were deleted. See the README for features and setup.

## Releasing

Installed copies update from this repo's GitHub Releases (`src/main/updater.ts`, electron-updater). A release is:

```bash
git add -A && git commit -m "…"            # releases are built from what's pushed
# add a "## x.y.z" section to CHANGELOG.md: short "- " items, written for friends, not developers
npm version patch --no-git-tag-version     # or minor; the version must go up
git commit -am "Release x.y.z" && git push
npm run release                            # scripts/release.mjs, about 20–25 min
```

`scripts/release.mjs` refuses to run if CHANGELOG.md has no section for the version, the version is already released, HEAD isn't pushed to `origin/main`, or there's no valid Mac signing certificate for the pinned team. Rerunning after a failure is safe: it reuses the draft, and electron-builder overwrites files already uploaded. It creates one **draft** release, runs `electron-builder --mac --win --publish always` into it, then publishes it.
- Don't let electron-builder create the release itself. The Mac and Windows uploads race to create it: once, one failed with "Published releases must have a valid tag", and the build stopped before writing `latest.yml` and `latest-mac.yml`.
- A release without both `latest*.yml` files is invisible to the updater. After releasing, check that the release has them.
- Publishing is outward-facing: only release when the user asks.

How updates behave:
- **Windows:** downloads in the background. The toolbar's **Update** button calls `quitAndInstall`; otherwise the update installs when the app quits.
- **Mac:** no Developer ID, so Squirrel.Mac can't swap the app; `src/main/updater.ts` does it itself. It downloads `Tabs-<version>-<arch>.zip`, checks its sha512 against `latest-mac.yml`, unpacks it with `ditto` and requires the same bundle ID, the expected version, `codesign --verify --deep --strict`, and the **same TeamIdentifier as the running app**. On `will-quit`, a detached bash script swaps the bundles with two renames (restoring the old one on failure), and reopens Tabs after **Update**. It logs to `update-swap.log` in userData.
  - If the app can't replace itself (on a read-only volume or App Translocation, a folder that isn't writable, or a different disk from userData) or any check fails, it falls back to downloading the DMG and opening it for a drag-replace.
  - The `-<arch>` suffix in the zip and DMG names (`mac.artifactName`) is what it matches on.
  - Tabs offers `app.moveToApplicationsFolder()` once when opened outside Applications (not in profiles).
- **Mac signing:** `mac.identity` pins the personal Apple ID's development certificate (team `P8MQ267KS3`). Never release a Mac build signed by another team: installed copies refuse it and stay on their version. `scripts/release.mjs` checks the certificate's team before building and the built app's team before publishing. Switching teams would strand every installed Mac copy on its version.
- **Mac entitlements:** the app is signed with the hardened runtime, so `build/entitlements.mac.plist` (for the app and, via `entitlementsInherit`, its helpers) must list every device sites use. With only electron-builder's defaults, macOS refuses the camera and microphone without asking, and Tabs isn't even listed in Privacy & Security. Check with `codesign -d --entitlements :- <app>`.
- **Windows installer:** `build/installer.nsh` (`nsis.include`) keeps installing when the installed version's uninstaller fails. A damaged `Uninstall Tabs.exe` otherwise blocks reinstalls and background updates ("Installer integrity check has failed", then "Tabs cannot be closed").
- **What's new:** `CHANGELOG.md` is bundled into the app (`src/renderer/src/ui/changelog.tsx`, a Vite `?raw` import). After an update, the browser UI shows the running version's section under the toolbar (`chrome/WhatsNew.tsx`) until it's dismissed. It's stored in localStorage as `browserr.whatsNew.seen`; a new install, where the intro is still pending, starts as seen. `browserr://whats-new` lists every version (Help menu and the ⋯ menu). The release script posts the same section as the GitHub release notes. Offer to draft the section from the commits since the last release.
- Dev builds and `--profile=…` copies never check for updates, except a packaged copy run with `BROWSERR_UPDATE_FEED=<url>` (a local feed for end-to-end tests).
- Releases are Apple Silicon Mac + Intel/AMD Windows only (`electron-builder.yml` targets). Windows on ARM runs the x64 build emulated.

## Names: what's "Tabs" and what stays "browserr"

User-facing text, `productName`, the app ID `com.itssotsot.tabs` and the installers are **Tabs**. These deliberately stay **browserr**:
- the `browserr://` internal scheme (it's the UI's origin; changing it signs everyone out of Firebase and drops localStorage);
- `window.browserr` / `BrowserrAPI`, localStorage keys and `BROWSERR_*` env vars;
- the Firebase project `browserr-share`.

On first launch, `src/main/index.ts` moves the old `Browserr[ (profile)]` data folder to `Tabs[ (profile)]`.

"Tabs" is also a common word, so don't start UI sentences with "Tabs" meaning browser tabs ("Pinned tabs, tabs playing audio…", not "Tabs playing audio…").

## Themes

The preloads put the theme on every page's root as `data-theme` (`src/preload/theme.ts`), in the browser UI, the overlay and browserr:// pages.
- Components use only tokens (`--bg`, `--bg-raised`, `--text-muted`, `--accent`…), never color literals, in `chrome.css` and `internal.css` alike. Default's tokens, in `styles/themes/default/tokens.css`, list them all; they sit on `:root`, so they fill in any a theme leaves out.
- A theme is a folder in `styles/themes/`: `tokens.css` under `[data-theme='<id>']`, plus `chrome.css` / `pages.css` if it changes more than colors (Paper does). Import them in `styles/themes/chrome.css` and `pages.css`.
- Add it to `ThemeId` and `THEMES` (`src/shared/constants.ts`): whether the toolbar takes on the page's color, and the window colors behind the UI (the theme's `--bg` and `--bg-raised`, light and dark).

## Site-specific code

Everything should work on any site from what pages have in common: the filter lists, og: tags, oEmbed, the page's own `<video>`/`<audio>`. Add a site only for what that can't do, in two places:
- `src/shared/links/<site>.ts`, listed in `SITES` in `links/index.ts`: what the site's links mean. That covers which links are the same page, the link to send (without playlist or tracking parts), the thumbnail, the start time and its oEmbed request. Sharing, chat links and tab matching use it (`knownLink`, `pageKey`, `cleanUrl`, `shareUrl`).
- `src/preload/sites/<site>.ts`, listed in `SITES` in `sites/index.ts`: what Tabs does on its pages. That covers which of its videos is the player (otherwise, whatever plays with sound), seeking its own way, extra ad styles, and ad handling the lists can't do.

Media controls (`src/preload/media-controls.ts`) also find media the document never sees: players inside a shadow root (Reddit's) and media never added to the page (Spotify's). A page-world hook on `play()` hands them to the preload. X, Instagram and Reddit need no site file. Spotify has one only to seek through its own progress bar. Setting its element's time leaves the player stuck.

Calls: the tab list's mic and camera buttons (`TabState.call`) use the best of three ways, per tab:
1. **Media Session's call actions** (`src/preload/call-controls.ts`). A site that registers `togglemicrophone` / `togglecamera` and reports `setMicrophoneActive` / `setCameraActive` gets working buttons with no site file.
2. **A site file's `call`** (Meet's, `src/preload/sites/meet.ts`). It reads and presses the site's own buttons. Match on something that doesn't change with the language (Meet's `data-is-muted` and icon ligatures), not labels. A background tab draws nothing, so Meet only shows the change when it draws: `Tab.controlCall` lets the tab draw for a moment (`setBackgroundThrottling(false)`).
3. **Tabs' own mute** (`Tab.call` with `by: 'tabs'`, `capture.ts`), for any page using a mic or camera that 1 and 2 don't cover. It switches the page's tracks off (`enabled = false`), so the call gets silence or black, but the site's own button doesn't show it. It only turns back on tracks it turned off.

With 1 and 2 the call shows you muted. Write a site file only for call sites without Media Session call actions.

Ad blocking is off on `UNBLOCKED_SITES` (`src/main/adblock.ts`): Spotify won't play a song until its ad has, and a blocked ad just leaves it stuck.

Ad blocking: `src/preload/adblock.ts` asks for the page's scriptlets synchronously and runs them before the page's scripts (`scriptletsFor` in `src/main/adblock.ts`). The library's own late injection runs the same bundle, which then skips itself. Before site-specific ad code, check whether the lists already have a rule. Run `getCosmeticsFilters` against `adblock-engine.bin` in userData.

## Site access (camera, microphone, location…)

- `src/main/permissions.ts` decides. In order: an extension's content setting; "allowed this time" (until the tab leaves the site); the site's saved choice; the default in settings (`blockedPermissions`); otherwise it asks. Camera and microphone are separate permissions. Early builds stored them as one, `media`, which `store.ts` splits on load.
- It asks under the address bar (overlay mode `permission`, `overlay/PermissionPrompt.tsx`), queued per tab in `permission-prompts.ts`. Questions go away unanswered when their page does. Pages that aren't tabs (extension popups) get a dialog.
- macOS's own access for Tabs is checked (`systemPreferences`): when it's off, Tabs says so and offers System Settings instead of asking.
- Electron's permission check can only say allowed or not, so undecided permissions would read as `denied` to the Permissions API, and sites that check first (Meet) never ask. `src/preload/permission-states.ts` reports `prompt` (and `default` for `Notification.permission`) from `permissionStates()`, and updates status objects the page holds after you answer.
- `src/preload/capture.ts` runs in every web frame. In the page's world, it follows the streams the page gets, for `TabState.capture` (the tab's signs, the address bar's Stop menu, and Memory Saver keeping it awake). It also applies your devices (`settings.devices`, by name, since ids differ per site). Pages only get the names of devices they may use.
- Testing: `--use-fake-device-for-media-stream=device-count=2` gives fake cameras and microphones. Don't pass `--use-fake-ui-for-media-stream`: it approves requests before the permission handler sees them.

## Building and running

- `npm run typecheck` before committing. `npm run dev` for development.
- Test in a throwaway profile (`BROWSERR_PROFILE=<name> npm run dev`) so the user's data isn't touched.
- The user runs the packaged app from `dist/mac-arm64/Tabs.app`. Don't rebuild into `dist/` while it's open; for test builds use `-c.directories.output=/tmp/…`.
- Firebase: always target `browserr-share` explicitly (`--project browserr-share`). Another project is the CLI's global default.
- The Firestore emulator runs on port 8181 (8080 belongs to another project).
