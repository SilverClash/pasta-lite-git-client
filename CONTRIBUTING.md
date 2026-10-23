# Contributing to Pasta Lite

Thanks for your interest in Pasta Lite. It is a small, alpha-stage Electron git client. It has no
framework and no bundler: you develop it from source, and releases are packaged as macOS DMGs
and, in alpha, Windows installers and Linux packages.
Bug reports, fixes and focused features are welcome.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). To report a security problem, do not
open an issue: follow [SECURITY.md](SECURITY.md) instead.

## Requirements

- **Node.js 22 (22.23.4+), 24 (24.22.1+) or 26 (26.12.1+)** (the October 2026 security releases; Electron's
  installer and ESLint 10 need 22.13 or newer anyway). CI runs the newest 22 and 24.
- **git 2.51 or newer.** The app checks this at startup (`src/gitcheck.js`) and refuses to run
  with an older git, because undo relies on `git reflog write`. The tests need it too. Apple's
  bundled git is usually older, so install git with Homebrew or your package manager. On Windows,
  install Git for Windows: the tests run git's hooks and the rebase editor through its `sh`.
- **OS:** the app is developed and tested on macOS. Windows support is alpha: the app works in
  testing on Windows 11, but it has had far less real use, so expect rough edges. Linux gets
  little hands-on use. CI runs the test suite on Ubuntu and on Windows (where a few tests that
  can't run there are skipped, each with its reason). Reports and fixes for other platforms are
  welcome.

## Setup

```sh
npm ci
npm start                    # launch the app
npm start -- /path/to/repo   # launch it with a repository open
```

To try the app on a realistic repository, build a demo one. It has branches, merges, an octopus
merge, tags, stashes, a bare "origin", a dirty working tree and an `images/` folder for the image
preview:

```sh
node scripts/demo-repo.js /tmp/demo   # creates /tmp/demo and /tmp/demo.origin.git next to it
npm start -- /tmp/demo
```

With no argument, the script creates `./demo-repo` and `./demo-repo.origin.git`. Both are
git-ignored. It refuses to write into a folder that is not empty.

## Tests

```sh
npm test                           # the whole suite: node --test test/*.test.js
node --test test/hunks.test.js     # one file
node --test --test-name-pattern="stage" test/hunks.test.js   # matching tests in one file
```

The whole suite takes about a minute on a recent Mac and several minutes on slower machines or CI
runners. The tests use Node's built-in test runner and don't start Electron. They load `src/`,
`main/` and the renderer scripts under plain Node (`test/renderer-harness.js` supplies a fake
`window`). They create throwaway repositories under the OS temp folder. `test/helpers.js` isolates
them from your `~/.gitconfig` and sets their own author, so no git identity setup is needed.

`node --test` runs each file in its own process, and `--test-timeout` then bounds each file's
whole run, not each test in it (on Node 22 a file's tests get no timeout from it). If you pass it,
give it well over the slowest file's time: some files take several minutes on Windows, and CI
there uses ten. On Windows, keep the paths a test creates well under 260 characters, the temp
folder included: Git for Windows doesn't enable `core.longpaths` by default, and neither the app
nor the tests set it, so git can't open a longer path ("Filename too long").

### Smoke run

To check the real app, the `--smoke` harness renders a view without ever showing a window, saves
it to a PNG, prints one JSON line and exits (0 on success, 1 on failure):

```sh
npx electron . --smoke /path/to/repo out.png   # a repository view
npx electron . --smoke out.png                 # the start screen (no repository)
```

It uses a throwaway `userData` folder, so your recent list and tabs are left alone, and it times
out after 30 seconds. Packaged builds ignore `--smoke`. `main/smoke.js` documents the `PL_SMOKE_*`
environment variables. `PL_SMOKE_JS` runs a script in the page, for example, which can drive the
real controls through DOM events to check a flow end to end. `node scripts/smoke-image-preview.js
[out.png]` does that for the image preview: it builds the demo repository and a conflicted merge
in a temporary folder and checks every image of the demo's `images/` folder in the real app.
`node scripts/smoke-clone.js [out.png]` does it for Clone Repository…: it serves two fixtures over a
local smart-HTTP server (`git http-backend` on 127.0.0.1), types their URL in the dialog, and checks a
folder that exists, a clone that opens in the tab, and a clone cancelled during its checkout. In a
smoke run main's folder dialog answers from `PL_SMOKE_CLONE_PARENT` (`main/smoke.js`), never with
the real home folder.

## Lint

```sh
npm run lint
```

ESLint, `@eslint/js` and `globals` are exact-pinned devDependencies, and `package-lock.json` pins
everything they depend on, so `npm ci` installs the very versions the script runs. CI runs it too.
`eslint.config.js` enables the recommended rules only, with no formatting rules and
no Prettier. The editor settings are in `.editorconfig`: 2 spaces, LF, UTF-8 and a final newline.
Please don't add new lint findings. Fixes for existing ones are welcome as separate PRs.

## Building the macOS app

The app is packaged with [electron-builder](https://www.electron.build), configured in the
`"build"` field of `package.json`. It makes two DMGs, one for Apple silicon (`arm64`) and one for
Intel (`x64`). Separate DMGs keep each download at about half the size of a universal one. Only
the runtime files go into the app (`main.js`, `main/`, `src/`, `renderer/`, the preloads and the
icon), plus our `LICENSE` and `NOTICE` and Electron's `LICENSE.electron.txt` and
`LICENSES.chromium.html` in `Contents/Resources`. The output goes to `dist/`, which is git-ignored.
Electron's two files come from `node_modules/electron/dist`, which `npm ci` doesn't create
(Electron 44 downloads its binary on first use): the `dist:*` scripts run `install-electron`
first, and a `beforePack` hook (`scripts/check-extra-resources.js`) stops any build, on every
platform, that is missing a `build.extraResources` file.

### Local build (unsigned)

Anyone can build the DMGs on a Mac, with no Apple account:

```sh
npm ci
npm run dist:mac:unsigned
# dist/Pasta-Lite-<version>-arm64.dmg, dist/Pasta-Lite-<version>-x64.dmg
# dist/mac-arm64/Pasta Lite Git client.app, dist/mac/Pasta Lite Git client.app
```

This build skips Developer ID signing and notarization. `scripts/mac-adhoc-sign.js` gives the app
an ad-hoc signature instead, so it runs on the Mac that built it. On another Mac, Gatekeeper blocks
it until you click Open Anyway in System Settings → Privacy & Security, or run
`xattr -dr com.apple.quarantine "/Applications/Pasta Lite Git client.app"`.

Packaged builds ignore `--smoke`. To smoke-test the packaged code, run it with the development
Electron, which allows the harness:

```sh
npx electron "dist/mac-arm64/Pasta Lite Git client.app/Contents/Resources/app.asar" --smoke /path/to/repo out.png
```

### Release build (maintainers)

Release DMGs are signed with a Developer ID and notarized by Apple, so they open with no
Gatekeeper warning. You need a paid Apple Developer account, Xcode or the Xcode command line tools,
and these one-time steps:

1. **Create a Developer ID Application certificate.** In Xcode, open Settings → Accounts, select
   the team, click Manage Certificates, then + → Developer ID Application. Or create it on
   developer.apple.com under Certificates, IDs & Profiles and install it. Check that it's in the
   login keychain:

   ```sh
   security find-identity -v -p codesigning   # lists "Developer ID Application: <name> (<team ID>)"
   ```

2. **Store the notary credentials in the keychain.** Create an app-specific password at
   [account.apple.com](https://account.apple.com) (Sign-In and Security → App-Specific Passwords).
   Then run this, which prompts for the password and saves it under the profile name
   `pasta-lite-notary`:

   ```sh
   xcrun notarytool store-credentials pasta-lite-notary --apple-id <your Apple ID> --team-id <team ID>
   ```

   The password stays in your keychain. It never goes into the repository or an environment
   variable.

Then build, sign and notarize:

```sh
APPLE_KEYCHAIN_PROFILE=pasta-lite-notary npm run dist:mac
```

electron-builder picks the "Developer ID Application" certificate from the keychain
(`mac.identity`; it never falls back to an Apple Development certificate). It signs with the
hardened runtime and `build/entitlements.mac.plist`, submits the app to the notary service and
staples the ticket. It also signs each DMG, and `scripts/mac-notarize-dmg.js` then notarizes and
staples the DMGs.
Each notarization usually takes a few minutes. The build fails if no Developer ID certificate is
found or `APPLE_KEYCHAIN_PROFILE` is not set, so it never produces a half-signed release.

Verify the result before you upload it:

```sh
npm run verify:mac
```

The script runs `codesign --verify --deep --strict` and `spctl -a -vvv -t exec` on each `.app`
(expect `source=Notarized Developer ID`), `spctl -a -vvv -t open --context
context:primary-signature` on each DMG, and `xcrun stapler validate` on both. It also prints
`spctl -a -vvv -t install` for the DMGs as information. If notarization fails, read Apple's log
with `xcrun notarytool log <submission id> --keychain-profile pasta-lite-notary`.

Then upload the two DMGs from `dist/` to the GitHub release (see
[Publishing a release](#publishing-a-release)).

**Entitlements.** `build/entitlements.mac.plist` grants only `com.apple.security.cs.allow-jit`,
which V8 needs for its JIT under the hardened runtime. The app has no native modules, loads no
unsigned libraries, sends no Apple Events (Open in Terminal runs `/usr/bin/open -a Terminal`) and
isn't sandboxed. Starting git or other programs needs no entitlement, because they run under their
own signatures.

## Building the Windows app

The `"win"` and `"nsis"` settings in `package.json` make an NSIS installer for x64 and one for
arm64, plus a portable zip for x64. The installer asks whether to install per user (the default,
with no administrator rights) or for all users, lets the user choose the folder, adds "Pasta
Lite" shortcuts to the desktop and the Start menu. Uninstalling leaves the app's data
(`%APPDATA%\Pasta Lite`) in place: electron-builder's uninstaller deletes app data only when run
with `--delete-app-data` or built with `nsis.deleteAppDataOnUninstall` (left at its default,
off), and even then only the folders named after the product and the package, not `Pasta Lite`.
The app icon is `assets/icon.ico`, made from `assets/icon.png`. The Windows builds are not
code-signed, and have no auto-update (no blockmaps or `latest.yml`).

```sh
npm ci
npm run dist:win
# dist/Pasta-Lite-<version>-x64-setup.exe, dist/Pasta-Lite-<version>-arm64-setup.exe
# dist/Pasta-Lite-<version>-win-x64.zip, dist/win-unpacked/, dist/win-arm64-unpacked/
```

This works on Windows, and on a Mac too: electron-builder downloads its own NSIS, and an
unsigned build needs no Wine. The macOS hooks (`scripts/mac-adhoc-sign.js`,
`scripts/mac-notarize-dmg.js`) do nothing for a Windows build, and the Electron fuses and the
asar integrity check apply to the Windows executable as well.

## Building the Linux app

Build on Linux with a supported Node.js (see [Requirements](#requirements)), system git 2.51 or
newer, and the GTK/NSS libraries Electron needs:

```sh
npm ci
npm run dist:linux
# dist/Pasta-Lite-<version>-linux-x86_64.AppImage
# dist/Pasta-Lite-<version>-linux-amd64.deb
# dist/linux-unpacked/
```

The initial targets are x64 AppImage and `.deb`; neither bundles git. The `.deb` declares
`git (>= 1:2.51.0)` (Debian/Ubuntu's git version has epoch `1:`), alongside Electron's desktop
libraries. AppImage users must install a suitable git themselves. Both packages include the
license notices. Linux packaging converts `assets/icon.icns` to standard PNG sizes for the
hicolor icon theme. Do not point `linux.icon` at the 1024px `assets/icon.png`: electron-builder
passes a PNG through at its original size, and hicolor does not list a 1024x1024 directory, so
the launcher and dock cannot find it. The `.desktop` entry passes local paths (`%F`), so a folder
dropped on the launcher opens as a repository. The macOS signing/notarization hooks skip Linux
artifacts.

`.github/workflows/linux.yml` runs on Ubuntu 22.04 for PRs, manual runs, and the release
workflow. Its `package` job builds both formats with nothing but `npm ci` and electron-builder,
checks the Debian dependency and writes `Pasta-Lite-<version>-SHA256SUMS-linux.txt`; the `linux`
artifact holds the packages and that file. Its `smoke` job adds the git PPA and Xvfb, checks the
icon lookup through GTK, installs the `.deb` with `apt` (its dependencies and install script),
and starts the installed `pasta-lite` with a fresh home: it must still be running after 20
seconds and have found git. It then loads the installed `app.asar` in development Electron with
the smoke harness, capturing the start screen and a demo repository, including an external
file-change watcher check, without disabling Chromium's sandbox. The `linux-smoke` artifact holds
the screenshots. On a tag, its `attest` job records signed build provenance for the AppImage and
the `.deb` (`gh attestation verify`).

Before calling a Linux build ready for a desktop environment, test the actual installed package
or AppImage there: launch from the desktop and terminal, open a repository, stage/commit/undo,
fetch/push with your configured authentication, open a terminal and reveal a file, and confirm
external changes refresh the view. Check Wayland and X11 separately. The automated smoke checks
cover renderer startup and file watching, not every desktop integration or authentication setup.

## Publishing a release

The release notes are the release's section of `CHANGELOG.md`, which PRs have filled in as they
were merged ([Changelog](#changelog)): nothing is written from scratch at release time.

1. Check `[Unreleased]` against what was merged: run Actions → changelog → Run workflow, which
   writes a draft from the merged PRs and commits since the last tag into the run's summary, or
   `npm run changelog:draft` locally. Give anything user-facing that's missing an entry, in the
   changelog's own words; the draft lists changes, it isn't text to paste.
2. Update the version in `package.json` and `package-lock.json`
   (`npm version <version> --no-git-tag-version`). In `CHANGELOG.md`, turn `## [Unreleased]` into
   `## [<version>] - <YYYY-MM-DD>`, add an empty `## [Unreleased]` above it, and update the link
   references at the end. `npm run release:check` checks that they agree. Merge that to `main`.
3. Tag the merge commit and push the tag:

   ```sh
   git tag v<version>
   git push origin v<version>
   ```

   The tag starts `.github/workflows/release.yml`. Its `check` job runs `release:check` for the
   tag first and fails the workflow before anything is built if the tag isn't `package.json`'s
   version or `CHANGELOG.md` has no dated section for it; it keeps that section, unwrapped, as the
   release notes (`npm run changelog:section -- <version> --unwrap`). Its `build` job, on a
   Windows runner with a read-only token, builds the Windows installers and the zip with
   `npx electron-builder --win --publish never`, and writes
   `Pasta-Lite-<version>-SHA256SUMS-windows.txt` for them (`<hash>  <file>` lines, as
   `sha256sum -c` reads them), since they aren't signed. It keeps these files as a workflow
   artifact named `windows`. The reusable `linux` job builds an x64 AppImage and `.deb`,
   installs and smoke-tests them, attests their provenance and keeps them and Linux checksums as
   the `linux` artifact. Its `publish` job then attaches both platforms' packages to the GitHub
   release for the tag, which it creates as a draft prerelease with those notes (and a note on the
   Windows and Linux builds) if there's none yet. The notes end in a hidden
   `<!-- notes from CHANGELOG.md -->` line: a later run (after a fix to `CHANGELOG.md`, with the
   tag moved and pushed again) replaces the notes of a draft that has that line, or no notes at
   all. Notes without the line are yours: the job leaves
   them alone, and warns if they differ from the changelog's. It only ever changes a draft:
   if the release is already published, the job fails and leaves the release's files alone, and
   if the draft gets published while the job is attaching its files, the job fails loudly too.
   Only a re-run replaces files (of the draft) it attached before.
   Running the workflow by hand on a branch (Actions → release → Run workflow) builds the
   workflow artifact only.
4. On a Mac, build, sign and notarize the DMGs from the same tag
   ([Release build](#release-build-maintainers)), then add them to the same release:

   ```sh
   gh release upload v<version> dist/Pasta-Lite-<version>-arm64.dmg dist/Pasta-Lite-<version>-x64.dmg
   ```

   Wait for the workflow to create the draft first, or create the release yourself
   (`gh release create v<version> --draft --prerelease`): the workflow then attaches its files to
   that one. Don't publish the release before the workflow has attached the Windows and Linux files.
5. Read the notes over and publish the release. It should carry two DMGs, two `-setup.exe`
   installers, the Windows zip, the Linux AppImage and `.deb`, and both SHA256SUMS files. A fix
   to the notes belongs in `CHANGELOG.md` too; if you edit the draft's notes by hand instead,
   delete the marker line so a re-run keeps them.

## Architecture

Git runs in the Electron main process; the pages talk to it over IPC and never touch Node.

- **`src/`** is the git layer and the app's logic, free of Electron: nothing in it requires
  `electron`, so all of it runs and is tested under plain Node (dialogs, windows and `spawn` are
  passed in). It runs the `git` CLI through `src/git-process.js` with fixed `-c` overrides and an
  env allowlist, and messages and path lists go on stdin. A cancel ends git's hooks too. Windows
  has no process groups, so there every git gets a random `PASTA_LITE_GIT_ID` that its hooks
  inherit and the cancel finds them by (so a daemon a cancelled command started, an MSYS
  gpg-agent or an ssh ControlPersist master, ends with it, which is fine: it starts again on
  next use), and for a command that writes the index, the `index.lock` the killed git left is
  removed when it can tell that git took it (`signalGroup`, `releaseKilledLock`). `src/git.js` is
  the git facade, `src/ops.js` the registry of operations and `src/runner.js` their queue (one
  write at a time per repository, reads don't wait).
- **`main.js` and `main/`** are the main process. `main.js` is the composition root; `main/` holds
  the window, the tabs (one `WebContentsView` and one `src/tab-session.js` per tab), the menu,
  IPC registration, the Help and crash UI, and the `--smoke` harness.
- **IPC** is one table, `src/ipc-contract.js`. Git operations go through a single `op` channel
  that accepts only the names in `ops.OPS`; main injects the tab's repository and checks the sender.
- **`preload.js` and `preload-tabs.js`** are sandboxed preloads that can require only `electron`.
  They expose `window.api` to a tab's page (`renderer/index.html`) and `window.tabsApi` to the tab
  strip (`renderer/tabs.html`).
- **`renderer/`** is plain JavaScript and CSS with no framework and no build step: window-global
  modules loaded by `<script>` tags (see below), a store, components in `renderer/components/` and
  the user-facing flows in `renderer/flows-*.js`.
- **Image preview** ([docs/plans/image-preview.md](docs/plans/image-preview.md)) is a second read
  next to the text diff, which stays as it is: the ops `commitImageSide` / `workdirImageSide`
  resolve one side of a diff to a git blob, worktree file, conflict stage or object in the local
  Git LFS cache (never fetched) and read its bytes under size caps (`src/blob-revisions.js`), and
  `src/image-preview.js` turns them into an `ImageSide` (an image with its bytes, or why there is
  none). HEIC, TIFF and PSD sides go to the OS thumbnailer (`src/os-thumbnail.js`, an adapter around
  Electron's `nativeImage.createThumbnailFromPath` that `main.js` passes to `ops.createRunner`; macOS
  only). `src/image-format.js` sniffs the format from the content and is shared with the
  renderer, like `src/error-kinds.js`. In the renderer the store loads the sides into
  `state.imagePreview` after a binary diff, an image's text diff or a conflicted image lands, the
  bytes go into a blob: URL cache (`renderer/image-cache.js`) and never into state, and
  `renderer/components/image-preview.js` shows them in place of the binary message or the rows
  (rules, zoom and comparison modes in `components/image-model.js`).
- **Clone** ([docs/plans/clone-repository.md](docs/plans/clone-repository.md)) runs as an *app op*
  in the shared runner (`src/ops.js` `APP`: not in `ops.OPS`, so the `op` channel can't reach
  it), which gives it the write queue, the busy indicator, cancellation and the quit and close
  guards. `src/clone-service.js` holds the use cases behind the four clone channels: the page
  never sends a path (the parent folder comes from main's folder dialog; the source is a typed
  network URL, `src/clone-url.js`, shared with the page: remotes only), `src/clone.js` creates
  the target folder and runs `git clone` with a transport allowlist, and `src/clone-cleanup.js`
  removes a failed clone's folder, only that one (its dev, inode and birth time checked again)
  and only with evidence that its clone failed (a `failed` mark, or a fetch that never finished).
  The folder is written to `clone.json` as soon as it exists and dropped once the clone succeeds,
  so a quit, a crash or a git that outlives its kill can't abandon it: `before-quit` waits for
  that write, and the next launch finishes the removal. The page's side is `renderer/clone.js`.
- **ssh failures** ([docs/plans/ssh-remote-errors.md](docs/plans/ssh-remote-errors.md)): ssh's
  lines and the display of a remote's ssh target live in `src/ssh-text.js`, which requires nothing
  (`src/git-errors.js` builds its connection rules from it) and is shared with the page like
  `src/error-kinds.js`. The stall watchdog (`src/ssh-stall.js`: end a git whose ssh failed but
  never exits, Windows by default) is built in the callers, `src/remote.js` and `src/clone.js`, on
  `spawnGit`'s `onStderr` and an abort combined with the op's signal: the process layer knows
  nothing about ssh. On Windows those two also give ssh Git for Windows' `false.exe` as its
  askpass (`src/ssh-env.js`), only when the user set none.
- **`test/`** has one `node:test` file per area. Git-layer tests run against throwaway repos
  (`test/helpers.js`); renderer tests load the scripts with a fake `window` and DOM
  (`test/renderer-harness.js`).

### Conventions

- **Plain-script renderer.** `renderer/index.html` loads each file with a `<script>` tag, in
  dependency order. Each file is an IIFE that publishes one window global, such as `window.Store`,
  `window.PLFlows`, `window.PLPolicy` or `window.Components`. It reads its dependencies from
  `window`, and there are no ES modules or imports. Files that tests need also export through
  `module.exports` when `module` exists (the "CommonJS-or-window" idiom). If you add a file, add
  its `<script>` tag in the right place and its global to `RENDERER_GLOBALS` in
  `eslint.config.js`.
- **Components** register with `Components.register(name, { mount(rootEl, store) })`. They read
  `store.state`, subscribe to keys, and change state only through `store.actions.*`. The contract
  is at the top of `renderer/store.js`. Writes go through the flows (`renderer/flows-*.js`), which
  share one lock and the busy and bare-repository guards.
- **Git-derived text is never HTML.** Branch names, commit messages, paths and diffs are rendered
  with `textContent` or `createTextNode`, never `innerHTML`. The pages run under a strict Content
  Security Policy with no inline scripts.
- **IPC is allowlisted.** Every channel is listed in the table in `src/ipc-contract.js`, and
  `main/ipc.js` registers exactly those channels. Git operations go through a single `op` channel,
  and only the names in `ops.OPS` (the descriptors in `src/ops.js`) are accepted. Each op
  validates its arguments (`src/op-validators.js`). The renderer never passes a repository path:
  main injects the sending tab's repository. To add an operation, add its descriptor, its
  validation and tests. `test/ipc-contract.test.js` checks that the preloads' channel literals
  match the table.
- **Errors carry a kind.** Failures are errors with an `err.kind` from the catalogue in
  `src/error-kinds.js`, which the renderer shares. Use an existing kind where one fits.
- **Tests come with changes.** Each area has a test file under `test/`. Git-layer tests run
  against real throwaway repositories rather than mocks of git.

## Commits

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) with a scope naming
the area:

```
feat(renderer): search field in the toolbar branch switcher
fix(rebase): friendlier pushed-commits warning
refactor(src): status and pull modules; no lazy requires left in the git layer
docs: architecture overview in CONTRIBUTING
test(main): guard the helpers both sandboxed preloads duplicate
chore: relicense under Apache 2.0
```

- Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore` and `ci`, and less often `perf`,
  `revert`, `security`, `build` and `style`. `feat`, `fix`, `perf`, `revert` and `security` are
  user-facing: the changelog draft puts them under Added, Fixed, Changed, Changed and Security,
  and the changelog check expects an entry for them ([Changelog](#changelog)). A `security`
  scope, or the word "security", "vulnerability" or a CVE id in the subject, makes any of them a
  Security entry. The other types are never user-facing by themselves.
- Common scopes: `src`, `main`, `renderer`, `ops`, `rebase`, `bare`, `tabs`, `graph` and `plan`.
- Write the subject in lower case, in the imperative or as a noun phrase, with no trailing period.
  Use the body to explain why.

## Changelog

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and is written by
hand, for users: what they notice and why it matters, not what the commits did. A PR with a
user-facing change adds its entry under `## [Unreleased]`, in the section that fits (`Added`,
`Changed`, `Fixed`, `Security`; Windows-only fixes under "On Windows:"), so the changelog is ready
when the release is cut.

The changelog workflow (`.github/workflows/changelog.yml`) checks that: a PR with user-facing
commits ([Commits](#commits)), changes to `main.js`, the preloads, `main/`, `renderer/`, `src/`,
`assets/` or `build/`, or changes to what `package.json` says about the app that ships (its
Electron version, runtime `dependencies`, `main` or `build` settings, but not its scripts or other
dev tools) fails its "changelog entry" check until it changes `[Unreleased]`. Run it locally with
`npm run changelog:check` (against `origin/main`). A maintainer adds the `skip-changelog` label to
a PR that needs no entry, such as a refactor or a fix to tests. Adding or removing the label runs
the check again, and the check reads the PR's labels when it runs, not from the event that started
it.

## License of contributions

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the same license as the project (inbound = outbound, per §5 of the
license). There is no CLA.

## Pull requests

- **Keep PRs focused**: one feature or fix per PR. Put unrelated clean-ups in their own PR.
- **Add or update tests** for every behaviour change, and run `npm test` before you push. CI runs
  it on macOS, Ubuntu and Windows.
- **Run `npm run lint`** and don't add findings.
- **Add a changelog entry** under `## [Unreleased]` for a change users notice
  ([Changelog](#changelog)).
- For UI changes, include a screenshot. A smoke-run PNG is fine.
- If the change alters how a part works, update its header comment, and the Architecture section
  above if the change moves responsibilities between parts.
- Fill in the pull request template. Say how you tested the change and which OS and git version
  you used.
