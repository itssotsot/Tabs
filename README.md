# Tabs

A Chromium-based desktop browser (Electron) with one extra superpower: a chat inbox with your friends, where the page you're on is one keystroke away. Every friend gets a chat automatically; for more people, start a group and invite them by username or email (or share its join code). YouTube links start at the exact second you were watching.

## Run it

```bash
npm install
npm run dev
```

Build installers:

```bash
npm run dist:mac   # .dmg + .zip for Apple Silicon in dist/
npm run dist:win   # NSIS installer for Intel/AMD Windows in dist/
```

Builds are unsigned for now. On macOS, a friend opening the app for the first time needs to right-click → Open (or run `xattr -cr /Applications/Tabs.app`). Proper signing needs an Apple Developer account.

## Releasing updates

Installed copies check [GitHub Releases](https://github.com/itssotsot/tabs/releases) 10 seconds after launch and every 4 hours (`src/main/updater.ts`), so friends only install by hand once. To ship a new version:

```bash
npm version patch --no-git-tag-version   # or minor; the version must go up
git commit -am "Release 0.2.1" && git push
npm run release                          # builds Mac + Windows and publishes them (uses your `gh` login)
```

- **Windows** downloads the update in the background. An **Update** button appears in the toolbar and restarts into the new version. If nobody clicks it, the update installs the next time the app quits.
- **Mac** downloads the new DMG in the background and checks its hash. **Update** quits Tabs and opens the DMG, and you drag Tabs onto Applications to replace it. (Replacing the app in place needs a Developer ID signature, which the Mac build doesn't have.)

Both menus have **Check for Updates…**. Development builds and extra profiles (`--profile=…`) never update.

## Testing with two accounts

Run a second copy of the app under its own profile. It has separate sign-in, tabs and history, and shows an orange profile label in the tab strip:

```bash
npm run open:main                       # opens the packaged app (-n, so it runs next to the friend profile)
npm run open:profile                    # opens a "friend" profile of the packaged app
PROFILE=alice npm run open:profile      # any other name
BROWSERR_PROFILE=friend npm run dev     # a profile in dev mode
```

## One-time Firebase setup

The Firebase project is `browserr-share` (Firestore in `eur3`, rules and indexes already deployed).

**Google sign-in must be enabled once in the console** (the CLI can't create the OAuth client):
Firebase console → Authentication → Get started → Sign-in method → Google → Enable → Save.

Sign-in opens in your normal browser (Google blocks OAuth inside embedded browsers) and hands the credential back to the app over `localhost`, which Firebase authorizes by default.

## Streaming DRM (Netflix, Spotify, Disney+)

Tabs uses [castLabs' Electron build](https://github.com/castlabs/electron-releases), which includes Widevine. It works in development as is. Streaming services only license Widevine to apps with a **production VMP signature**, which castLabs issues for free:

```bash
python3 -m pip install --upgrade castlabs-evs
python3 -m castlabs_evs.account signup    # once
```

After that, `npm run dist:mac` / `npm run dist:win` sign the app automatically (`build/vmp-sign.cjs`). Without an account the build prints a warning and skips signing.

castLabs publishes each Electron release a little after the official one, so check for updates now and then:

```bash
npm run check-electron               # compare installed vs castLabs vs official Electron
npm run check-electron -- --update   # install the newest castLabs build in the same major version
```

## Performance

On top of Chromium, Tabs does what Chrome adds itself:

- **Lazy tab restore**: only the visible tab loads at startup; the rest load (with their back/forward history) when opened.
- **Memory Saver**: background tabs are paused after 5 minutes and unloaded after 30 (5 when memory is low), then restored with history and scroll position. Pinned tabs, tabs playing audio, tabs with open popups, and sites allowed to send notifications stay awake. Toggle in Settings.
- **Loading predictor**: learns which servers each site uses and connects to them as soon as you start going there, or while the address bar highlights it.
- **Ad and tracker blocking**, including YouTube video ads.

Electron itself doesn't support Chromium's back/forward cache (`BackForwardCacheDisabledForDelegate`), so Back/Forward reload the page.

## Using it

| Action | Shortcut |
| --- | --- |
| Send the current page to a friend or group | `⌘⇧S` / `Ctrl+Shift+S`, the **Send** button, the send icon in YouTube's player, or right-click → Send |
| Open the inbox | `⌘⇧L` / `Ctrl+Shift+L` |
| In the send picker | `↵` send · `⇧↵` send and keep open (to send to several chats) · `esc` close |

Plus the usual browser shortcuts: `⌘T`, `⌘W`, `⌘⇧T`, `⌘L`, `⌘F`, `⌘D`, `⌘1…9`, `⌃Tab`, `⌘[`/`⌘]`, zoom, dev tools, and so on.

## How it's built

- `src/main` – Electron main process: windows, tabs (one `WebContentsView` each), menus, downloads, permissions, ad blocking, session restore, the Google sign-in bridge.
- `src/preload` – `chrome.ts` (browser UI API) and `tab.ts` (runs in web pages: exposes nothing, except internal-page APIs on `browserr://` pages and the YouTube send button).
- `src/renderer` – React UI: `chrome/` (tab strip, toolbar, sidebar), `overlay/` (address-bar dropdown and send picker, drawn above the page), `internal/` (new tab, history, bookmarks, settings, error pages), `auth/` (sign-in page opened in the system browser).
- `firestore.rules` – who can read and write what. Only a room's members can read or post its messages. A direct chat (`dm_<uidA>_<uidB>`) can only be created by two accepted friends and goes away with the friendship. For group rooms, invitees (by uid, or by the verified email they sign in with) can see the room and join; anyone else needs its join code.

Data model: `users/{uid}`, `usernames/{name}`, `friendships/{uidA_uidB}`, `rooms/{id}` (with `messages/{id}` and `joins/{uid}` subcollections), `roomCodes/{code}`.

## Tests

```bash
npm run typecheck
npm run test:rules   # security-rules tests against the Firestore emulator (needs Java)
```

`BROWSERR_FAST_MEMORY_SAVER=1 npm run dev` shrinks the Memory Saver timers (10s pause, 20s unload) for testing.

During development you can drive the app over the DevTools protocol:

```bash
BROWSERR_DEBUG_PORT=9333 npm run dev
node scripts/cdp.mjs                       # list pages
node scripts/cdp.mjs index.html "window.browserr.nav.go('youtube.com')"
```
