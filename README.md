<p align="center">
  <img src="assets/icon.png" alt="Pasta Lite Git client" width="128" height="128">
</p>

<h1 align="center">Pasta Lite Git client</h1>

<p align="center"><em>Untangle your history</em></p>

Pasta Lite is a minimal, graph-first desktop git client. The commit graph sits in the middle of the
window, with your branches on the left and your working changes on the right. It covers the everyday
workflow: stage, commit, branch, sync, stash, merge, rebase and undo. It's built on Electron and runs
your system `git`, so your existing SSH keys, credential helper and git config just work.

> **Status: alpha (0.2.1).** This is an early preview. Expect rough edges, and please report what you
> find.

## Screenshots

![The commit graph with branches, tags and stashes in the sidebar and the working changes panel](docs/screenshots/graph.png)

![A working-tree diff with per-hunk Stage and Discard buttons](docs/screenshots/diff.png)

![The interactive rebase editor with pick, squash, reword and drop](docs/screenshots/rebase.png)

## Features

**Graph and history**
- Lane-based commit graph with branch and tag labels, merge and octopus-merge lines, and resizable, hideable columns.
- History loads in pages, so large repositories open quickly.
- Commit details with the changed files, as a path list or a tree, and each file's diff, with a before / after preview for images (side by side, swipe, onion skin or difference): PNG, JPEG, GIF, WebP, AVIF, BMP, ICO and SVG, Git LFS images too, and HEIC, TIFF and PSD as a preview made by the system on macOS.
- Sidebar with local branches, remotes, tags and stashes, grouped into folders by prefix, with a filter box.

**Staging and committing**
- Stage, unstage and discard whole files, single hunks or selected lines.
- Commit, Commit All and amend, including a message-only amend.
- Discards are backed up, so they can be undone.

**Branches**
- Create, check out and delete branches, and check out remote branches as tracking branches.
- A branch switcher in the toolbar with a search field.
- Uncommitted changes that would block a checkout are stashed and re-applied for you.

**Remotes**
- Fetch (with prune and tags; a local tag that differs from the remote is kept and reported).
- Pull as fast-forward if possible, fast-forward only, or rebase. The chosen mode becomes the button's default.
- Push with an explicit refspec, set the upstream on the first push, and offer force-with-lease when a push is rejected.
- Cancel a running fetch, pull, push or rebase from the toolbar.

**Stash**
- Stash (untracked files included), apply, pop and drop, from the toolbar or the sidebar.

**Undo and redo**
- Undo and redo commits, checkouts, branch deletes and discards, driven by the HEAD reflog.

**Merge and rebase**
- Merge a branch into the current one, and rebase the current branch onto another branch or commit.
- Interactive rebase editor: pick, reword, edit, squash, fixup and drop, with drag-to-reorder. It warns you when the rewritten commits are already pushed.
- Uncommitted changes are autostashed and restored once the rebase or merge finishes or is aborted.
- Conflict helpers: a banner with Continue, Skip and Abort, resolve a file with ours or theirs, and mark all as resolved.

**Worktrees and bare repositories**
- Open linked worktrees and bare repositories. A bare repository shows its history and offers its worktrees.
- A Worktrees section in the sidebar lists linked worktrees with their branch, locked and dirty state. Open one, reveal it in the file manager, copy its path, lock or unlock it, delete it (with a force confirmation if it has changes), or prune stale ones after a preview.

**Tabs and repositories**
- Clone a repository (File > Clone Repository…, ⇧⌘N, or Clone… on the start screen) from an HTTPS, HTTP, SSH or git URL into a folder you pick, with progress and Cancel. The clone opens in the tab, or in a new tab next to the one you started it from.
- One repository per tab, with reorderable tabs and tabs restored on the next launch.
- A repository picker (⌘P) that searches your recent repositories, plus File > Open Recent.
- Open the repository in your terminal.
- Keyboard shortcuts for the common actions: undo/redo, fetch, new branch, stage/unstage all, commit.

**Safety**
- Before opening a repository whose own git config runs commands (a filter driver, for example) or whose hooks folder has hooks git would run, Pasta Lite asks you to trust it first. The `ext::` transport is always blocked.
- The Electron renderers are sandboxed and context-isolated, with no Node access. Git runs only in the main process, which accepts only a fixed list of operations.

## Requirements

- **git 2.51 or newer**, installed on your system. Pasta Lite checks this at startup and won't run with an older git (undo depends on `git reflog write`). The git that ships with macOS is usually older, so install one with [Homebrew](https://brew.sh) (`brew install git`). The app finds Homebrew's git even when it's started from the Finder or the Dock. On Windows, install [Git for Windows](https://git-scm.com/download/win) (or run `winget install --id Git.Git -e`). The app uses the git on your PATH, or else finds Git for Windows in its usual install folder (under Program Files, or `AppData\Local\Programs` for a per-user install).
- **macOS 13 or newer**, or **Windows 10 or 11** (x64 or arm64), for the downloadable app.
- **Node.js 22.12 or newer**, only to run it from source (Electron's installer needs it).
- **Platforms:** developed and tested on macOS. Windows support is alpha: the app works in testing on Windows 11 and CI runs the test suite on Windows too (skipping a few tests that can't run there), but it has seen far less real use than on macOS, so expect rough edges and please [report what you find](https://github.com/SilverClash/pasta-lite-git-client/issues). Linux is supported in the code but not yet tested, and there are no builds for it.

## Download

### macOS

Download the DMG for your Mac from the [Releases page](https://github.com/SilverClash/pasta-lite-git-client/releases):

| Your Mac | File |
| --- | --- |
| Apple silicon (M1 and later) | `Pasta-Lite-<version>-arm64.dmg` |
| Intel | `Pasta-Lite-<version>-x64.dmg` |

Not sure which one you have? Choose Apple menu → About This Mac: an Apple silicon Mac lists a "Chip" such as Apple M2, an Intel Mac lists a "Processor". Open the DMG and drag Pasta Lite Git client to Applications.

The app is signed with a Developer ID and notarized by Apple, so it opens like any other app. If macOS still refuses to open it, go to System Settings → Privacy & Security and click Open Anyway.

### Windows (alpha)

Windows support is alpha: the app works in testing, but it has had far less real use than on macOS, so expect rough edges, and please [report what you find](https://github.com/SilverClash/pasta-lite-git-client/issues). Download the installer for your PC from the same [Releases page](https://github.com/SilverClash/pasta-lite-git-client/releases):

| Your PC | File |
| --- | --- |
| Intel or AMD (x64) | `Pasta-Lite-<version>-x64-setup.exe` |
| ARM (arm64), such as a Snapdragon laptop | `Pasta-Lite-<version>-arm64-setup.exe` |

Not sure which one you have? Open Settings → System → About and look at "System type". There's also a portable `Pasta-Lite-<version>-win-x64.zip` that runs without installing: unzip it and start `Pasta Lite Git client.exe`.

The installer asks whether to install for you only (the default, with no administrator rights needed) or for all users, lets you choose the folder, and adds a "Pasta Lite" shortcut to the desktop and the Start menu. Uninstall it from Settings → Apps. Your settings and recent repositories are kept, in `%APPDATA%\Pasta Lite`: delete that folder to remove them too.

The Windows builds are not code-signed yet, so SmartScreen shows "Windows protected your PC" the first time you run the installer. Click More info, then Run anyway. To check that the download is the one the release published, compare its hash with the line for it in `Pasta-Lite-<version>-SHA256SUMS-windows.txt` on the release (PowerShell prints it in capitals):

```powershell
Get-FileHash .\Pasta-Lite-<version>-x64-setup.exe -Algorithm SHA256
```

## Getting started

To run it from source instead:

```sh
git clone https://github.com/SilverClash/pasta-lite-git-client.git
cd pasta-lite-git-client
npm ci
npm start
```

To open a repository, you can:

- pass its path on the command line: `npm start -- /path/to/repo`
- use the repository picker on the start screen or in the toolbar (⌘P), or File > Open Recent
- use File > Open Repository… (⇧⌘O), or ⌘O to open a folder in the current tab
- clone one with File > Clone Repository… (⇧⌘N) or Clone… on the start screen

On Windows and Linux, use Ctrl in place of ⌘.

### Try it on a demo repository

`scripts/demo-repo.js` builds a throwaway repository with branches, merges, tags, a local bare `origin`,
stashes and a dirty working tree:

```sh
node scripts/demo-repo.js /tmp/pasta-demo
npm start -- /tmp/pasta-demo
```

It also creates `/tmp/pasta-demo.origin.git` next to it. The screenshots above were taken on this repository.

## Known limitations

- No init: create a new repository from a terminal (`git init`), then open it.
- Clone makes a plain full clone of the default branch: no shallow, partial or single-branch clones, and no submodules (it says when the repository has some). Clone is for remotes only: a local path or `file://` URL isn't accepted (copy or clone such a repository from a terminal, then open it).
- No credential or passphrase prompts. Git runs with `GIT_TERMINAL_PROMPT=0`, so use a credential helper or ssh-agent for remotes that need authentication.
- No cherry-pick, revert or reset.
- Tags are shown, but there's no UI for creating or deleting them.
- No renaming branches, deleting remote branches or managing remotes.
- No commit search, file history or blame.
- Dark theme only.
- HEIC, TIFF and PSD images preview only on macOS, as the system's thumbnail (at most about 2,048 pixels wide), not at full resolution. On Windows and Linux they say "preview not supported".
- Downloadable builds for macOS and, in alpha, Windows. None for Linux yet.

## Development

```sh
npm test                      # the whole suite (about 9 minutes)
node --test test/git.test.js  # a single test file
```

The architecture, the project layout and the code conventions are described in
[CONTRIBUTING.md](CONTRIBUTING.md#architecture). Read it before opening a pull request. Changes are listed in
[CHANGELOG.md](CHANGELOG.md), and the [Code of Conduct](CODE_OF_CONDUCT.md) applies to everyone taking part.

## Security

To report a vulnerability, please follow [SECURITY.md](SECURITY.md) rather than opening a public issue.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

### Trademarks

"Pasta Lite" and its logo (the files in `assets/`) are trademarks of Alexey Zhuravlev and are not
covered by the Apache license. If you fork or redistribute the project, please use a different name
and logo unless you have permission. Using the name to refer to or describe the project is fine.
