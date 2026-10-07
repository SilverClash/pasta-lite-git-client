# Contributing to Pasta Lite

Thanks for your interest in Pasta Lite. It is a small, alpha-stage Electron git client. It has no
framework and no bundler: you develop it from source, and releases are packaged as macOS DMGs.
Bug reports, fixes and focused features are welcome.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). To report a security problem, do not
open an issue: follow [SECURITY.md](SECURITY.md) instead.

## Requirements

- **Node.js 22.12 or newer** (Electron's installer needs it; CI runs 22 and 24). `npm run lint`
  needs 22.13 or newer, because ESLint 10 requires it.
- **git 2.51 or newer.** The app checks this at startup (`src/gitcheck.js`) and refuses to run
  with an older git, because undo relies on `git reflog write`. The tests need it too. Apple's
  bundled git is usually older, so install git with Homebrew or your package manager.
- **OS:** the app is developed and tested on macOS. Windows and Linux are untested, though CI runs
  the test suite on Ubuntu. Reports and fixes for other platforms are welcome.

## Setup

```sh
npm ci
npm start                    # launch the app
npm start -- /path/to/repo   # launch it with a repository open
```

To try the app on a realistic repository, build a demo one. It has branches, merges, an octopus
merge, tags, stashes, a bare "origin" and a dirty working tree:

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
real controls through DOM events to check a flow end to end.

## Lint

```sh
npm run lint
```

ESLint is not a dependency. The script runs a pinned version through `npx`, so the first run
downloads it. `eslint.config.js` enables the recommended rules only, with no formatting rules and
no Prettier. The editor settings are in `.editorconfig`: 2 spaces, LF, UTF-8 and a final newline.
Please don't add new lint findings. Fixes for existing ones are welcome as separate PRs.

## Building the macOS app

The app is packaged with [electron-builder](https://www.electron.build), configured in the
`"build"` field of `package.json`. It makes two DMGs, one for Apple silicon (`arm64`) and one for
Intel (`x64`). Separate DMGs keep each download at about half the size of a universal one. Only
the runtime files go into the app (`main.js`, `main/`, `src/`, `renderer/`, the preloads and the
icon), plus our `LICENSE` and `NOTICE` and Electron's `LICENSE.electron.txt` and
`LICENSES.chromium.html` in `Contents/Resources`. The output goes to `dist/`, which is git-ignored.

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

Upload the two DMGs from `dist/` to the GitHub release.

**Entitlements.** `build/entitlements.mac.plist` grants only `com.apple.security.cs.allow-jit`,
which V8 needs for its JIT under the hardened runtime. The app has no native modules, loads no
unsigned libraries, sends no Apple Events (Open in Terminal runs `/usr/bin/open -a Terminal`) and
isn't sandboxed. Starting git or other programs needs no entitlement, because they run under their
own signatures.

## Architecture

Git runs in the Electron main process; the pages talk to it over IPC and never touch Node.

- **`src/`** is the git layer and the app's logic, free of Electron: nothing in it requires
  `electron`, so all of it runs and is tested under plain Node (dialogs, windows and `spawn` are
  passed in). It runs the `git` CLI through `src/git-process.js` with fixed `-c` overrides and an
  env allowlist, and messages and path lists go on stdin. `src/git.js` is the git facade,
  `src/ops.js` the registry of operations and `src/runner.js` their queue (one write at a time per
  repository, reads don't wait).
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
  resolve one side of a diff to a git blob or worktree file and read its bytes under size caps
  (`src/blob-revisions.js`), and `src/image-preview.js` turns them into an `ImageSide` (an image
  with its bytes, or why there is none). `src/image-format.js` sniffs the format from the content
  and is shared with the renderer, like `src/error-kinds.js`. In the renderer the store loads both
  sides into `state.imagePreview` after a binary diff lands, the bytes go into a blob: URL cache
  (`renderer/image-cache.js`) and never into state, and `renderer/components/image-preview.js`
  shows them in place of the binary message (rules in `components/image-model.js`).
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

- Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore` and `ci`.
- Common scopes: `src`, `main`, `renderer`, `ops`, `rebase`, `bare`, `tabs`, `graph` and `plan`.
- Write the subject in lower case, in the imperative or as a noun phrase, with no trailing period.
  Use the body to explain why.

## License of contributions

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the same license as the project (inbound = outbound, per §5 of the
license). There is no CLA.

## Pull requests

- **Keep PRs focused**: one feature or fix per PR. Put unrelated clean-ups in their own PR.
- **Add or update tests** for every behaviour change, and run `npm test` before you push. CI runs
  it on macOS and Ubuntu.
- **Run `npm run lint`** and don't add findings.
- For UI changes, include a screenshot. A smoke-run PNG is fine.
- If the change alters how a part works, update its header comment, and the Architecture section
  above if the change moves responsibilities between parts.
- Fill in the pull request template. Say how you tested the change and which OS and git version
  you used.
