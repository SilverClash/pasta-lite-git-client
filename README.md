<p align="center">
  <img src="assets/icon.png" alt="Pasta Lite Git client" width="128" height="128">
</p>

<h1 align="center">Pasta Lite Git client</h1>

<p align="center"><em>Untangle your history</em></p>

Pasta Lite is a minimal, graph-first desktop git client. The commit graph sits in the middle of the
window, with your branches on the left and your working changes on the right. It covers the everyday
workflow: stage, commit, branch, sync, stash, merge, rebase and undo. It's built on Electron and runs
your system `git`, so your existing SSH keys, credential helper and git config just work.

> **Status: alpha (0.3.0).** This is an early preview. Expect rough edges, and please report what you
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
- A branch switcher in the toolbar with a search field that also finds remote branches, fetching them on the first query.
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
- **macOS 13 or newer**, or **Windows 10 or 11** (x64 or arm64). Linux builds (alpha) are for x64: Ubuntu 22.04 or newer, or another distribution with glibc 2.35 or newer.
- **Node.js 22 (22.23.4+), 24 (24.22.1+) or 26 (26.12.1+)** (the October 2026 security releases), only to run it from source.
- **Platforms:** developed and tested on macOS. Windows support is alpha: the app works in testing on Windows 11 and CI runs the test suite on Windows too (skipping a few tests that can't run there), but it has seen far less real use than on macOS, so expect rough edges and please [report what you find](https://github.com/SilverClash/pasta-lite-git-client/issues). Linux support is alpha too: CI runs the tests on Ubuntu and smoke-tests the packaged code in Electron, but desktop environments and distributions need more hands-on testing.

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

### Linux (alpha)

Download a Linux package from the [Releases page](https://github.com/SilverClash/pasta-lite-git-client/releases):

| Your system | Download |
| --- | --- |
| Ubuntu / Debian (recommended format) | `Pasta-Lite-<version>-linux-amd64.deb` |
| Other compatible Linux distributions, or a portable app | `Pasta-Lite-<version>-linux-x86_64.AppImage` |

Both downloads are for **Intel/AMD 64-bit PCs** (`uname -m` should print `x86_64`); Linux ARM
builds are not available yet. You need **system git 2.51 or newer**. Check before installing:

```sh
git --version
```

You do not need to install Node.js or Electron to use either download.
Run the commands below in the folder containing your download, replacing `<version>` with the
version number in its filename.

#### Ubuntu / Debian: install the .deb

```sh
sudo apt install ./Pasta-Lite-<version>-linux-amd64.deb
pasta-lite
```

Enter your administrator password when asked. `apt` installs the required desktop libraries and
adds **Pasta Lite Git client** to your applications menu. You can launch it there or with
`pasta-lite`, and open a repository directly with `pasta-lite /path/to/repository`.

If `apt` reports an unmet git dependency, install a newer **Git package** before retrying. Your
system's default package may be older than 2.51. The [official Git Linux installation instructions](https://git-scm.com/install/linux)
include the `git-core` PPA for Ubuntu; use a package source appropriate to your distribution.
The app relies on your existing Git configuration, SSH agent and credential helper.
Authentication must already work without interactive prompts.

On Ubuntu 24.04 and newer, the `.deb` installation also configures the Chromium sandbox and an
AppArmor profile. An AppImage or development binary may be blocked by the system's
user-namespace restrictions. Keep sandboxing enabled for normal use.

To update, quit the app, download the newer `.deb` and install it with the same `apt` command.
To uninstall, run `sudo apt remove pasta-lite`; your settings and recent repository list are kept.

#### Portable AppImage

Save the file somewhere you want to keep it, then make it executable and launch it:

```sh
chmod +x Pasta-Lite-<version>-linux-x86_64.AppImage
./Pasta-Lite-<version>-linux-x86_64.AppImage
```

The AppImage requires system git 2.51 or newer too; it does not install Git or add a desktop
launcher. AppImages need FUSE 2 support. If FUSE is unavailable, extract and run with:

```sh
./Pasta-Lite-<version>-linux-x86_64.AppImage --appimage-extract-and-run
```

On Ubuntu with sandbox restrictions, use the `.deb` installation above. To update an AppImage,
quit the app and replace the file with the newer download.

Linux builds are alpha and unsigned. To check a download, run `sha256sum` on the file and compare
its hash with the matching entry in `Pasta-Lite-<version>-SHA256SUMS-linux.txt` from the same
release. The release workflow also records signed build provenance for both packages: with the
[GitHub CLI](https://cli.github.com), this confirms the file was built by this repository's
release workflow, not just that it matches a checksum on the same page:

```sh
gh attestation verify Pasta-Lite-<version>-linux-amd64.deb --repo SilverClash/pasta-lite-git-client
```

If the app fails to open, launch it from a terminal and include its output, distribution and
`git --version` when [reporting an issue](https://github.com/SilverClash/pasta-lite-git-client/issues).

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
- Windows and Linux downloadable builds are alpha; Linux packages currently target x64 only.

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
