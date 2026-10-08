# Changelog

All notable changes to Pasta Lite are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is 0.x,
minor versions may contain breaking changes.

## [Unreleased]

### Added

- Image preview in the diff view: PNG, JPEG, GIF, WebP, AVIF, BMP, ICO and SVG files show before and
  after side by side, with dimensions, file size and the size change, on a checkerboard for
  transparency. Large images load on request; formats that can't be shown say so.
- Image comparison: besides side by side, **Swipe** (drag the divider between before and after),
  **Onion skin** (fade after over before) and **Difference** (unchanged pixels turn black). Zoom
  from 12.5% to 3200%, with Fit and 100%; pixels show as squares above 100%. Keys while an image
  shows: + and - zoom, 0 fits, 1 is 100%, M switches the comparison mode.
- An SVG's change opens as the rendered image, with a **Preview | Text** switch for its text diff.
  The choice is remembered.
- Images stored in Git LFS preview when their object is already downloaded (in `.git/lfs`); nothing
  is ever fetched, and an object that isn't there says "not available locally".
- A conflicted image shows the base, ours and theirs versions side by side.
- HEIC, TIFF and PSD images preview on macOS and Windows through the system's thumbnailer (QuickLook
  on macOS; on Windows it depends on the installed codecs). The pane says "Preview by macOS" and, for
  a large image, the size it was scaled to; dimensions and file size are the original's. A multi-page
  TIFF shows its first page. On Linux, or when the system can't read the file, they still say
  "preview not supported".

## [0.2.1] - 2026-10-04

### Added

- Delete several local branches at once. In the sidebar, ⌘-click (Ctrl-click on Windows and Linux)
  or ⌘/Ctrl+Space adds a branch to the selection and Shift-click or Shift+↑/↓ selects a range; Esc
  goes back to one. Right-click the selection for **Delete N branches**, or right-click a folder for
  **Delete all N branches in a folder** (subfolders included). One confirmation lists the branches;
  the checked-out branch and branches checked out in other worktrees are left out. Branches that
  aren't fully merged can be force-deleted together, and any that fail are listed without stopping
  the rest. Undo restores the deleted branches one at a time, newest first.
- Worktrees section in the sidebar. It lists the repository's worktrees, the main one included, with
  their branch or short SHA, marks the main and current worktrees, and shows locked (with the
  reason), missing and dirty states; dirty dots load while the section is open. Right-click a
  worktree to open it, reveal it in the file manager, copy its path, lock or unlock it (with an
  optional reason), or delete it; **Prune** previews what will be removed first. Deleting a worktree
  with changes asks for a force confirmation, and the main, current and locked worktrees are never
  deleted, nor one with a rebase or merge stopped in it, another worktree inside it or a git
  operation running there. Deleting a detached worktree warns how many of its commits no branch or
  tag keeps. The dirty check skips a worktree whose own config could run a command the repository
  wasn't trusted for. Changes made in a terminal show up automatically.
- A tab with a linked worktree open says so. Its tab shows a tree icon and reads `project · folder`
  (the window title too), and a **worktree** chip next to the repository name shows the worktree's
  folder and its main worktree; click it to jump to the worktree in the sidebar. Branches checked
  out in another worktree can't be checked out from the branch switcher, the sidebar or the graph;
  their Checkout is disabled with the worktree's path.

### Changed

- A repository trusted earlier under another spelling of its path (another letter case on a
  case-insensitive disk) is recognised, instead of asking again.

### Fixed

- Deleting a branch that is checked out in a linked worktree of a normal repository now says so up
  front instead of failing after the confirmation.

## [0.2.0] - 2026-09-28

### Added

- The sidebar and the details panel can be resized: drag the handle on their inner edge (or focus
  it and use the arrow keys). Double-click the handle to reset a panel. Widths are kept across
  restarts.

### Changed

- The app is now called **Pasta Lite Git client** (in the Finder, the Dock, the window title and
  the app menu), so it is easier to find and clearly a git client. Your recent repositories, tabs,
  trusted repositories and logs are kept: they stay in the existing `Pasta Lite` folders. The DMG
  file names are unchanged (`Pasta-Lite-<version>-<arch>.dmg`). If you installed 0.1.0, delete
  the old `Pasta Lite` app from Applications after installing the new one, and quit the old app
  before opening the new one: only one copy runs at a time, so while 0.1.0 is open the new
  version brings its window forward instead of starting.

## [0.1.0] - 2026-09-27

The first public release, an **alpha**. Pasta Lite is a minimal, graph-first desktop git client
built on Electron that runs your system git. It covers the everyday workflow: staging, commits,
branches, fetch, pull and push, stash, merge, rebase (including interactive rebase), conflicts,
worktrees and undo. It needs git 2.51 or newer. macOS is the tested platform: download the DMG,
or run it from source with Node.js 22.12 or newer.

### Added

- **Commit graph**: a graph-first history of all branches, remotes, tags and stashes, with
  coloured lanes. More history loads as you scroll. The graph has resizable columns, a commit
  details panel, and a diff view for commits and for the working tree.
- **Staging**: stage and unstage by file, by hunk or by selected lines. Discard changes the same
  way, and a backup lets you undo a discard. Stage or unstage everything at once.
- **Commits**: commit and amend, with the last message offered when you amend, and a commit
  message draft that is kept per repository.
- **Remotes**: fetch, pull (merge or rebase, including fast-forward only) and push. A push that
  has to replace remote commits uses `--force-with-lease` against the remote-tracking ref you
  last saw. You can set an upstream, and cancel a running fetch, pull or push.
- **Branches**: check out, create and delete branches. Local changes that block a checkout are
  stashed and restored automatically. The sidebar lists local and remote branches, tags and
  stashes, with a filter.
- **Toolbar branch switcher** with a search field.
- **Stash**: stash, apply, pop and drop.
- **Undo and redo** driven by the HEAD reflog: commits, checkouts, discards and branch deletion.
- **Merge**: fast-forward, `--no-ff` or fast-forward only, with an automatic stash of local
  changes that comes back when the merge is done. Conclude or abort a merge that stopped.
- **Rebase**: rebase the current branch onto another. Interactive rebase has an editor to
  reorder, pick, reword, edit, squash, fixup and drop commits. Continue, skip or abort a rebase,
  and get a warning before rewriting commits that were already pushed.
- **Conflicts**: see conflicted files, resolve a file with ours or theirs, and mark everything
  resolved. A banner shows the merge or rebase in progress.
- **Worktrees**: linked worktrees open like any repository. A branch checked out in another
  worktree is reported clearly instead of failing with git's error.
- **Bare repositories**: open a bare repository and browse its history. The banner lists its
  worktrees and opens one in a tab. Operations that need a working tree are refused.
- **Tabs**: one repository per tab, restored at the next start.
- **Repository picker**: a start screen and toolbar picker with recent repositories, open tabs
  and Open Repository.
- **Trust prompt** before opening a repository whose own git config or hooks would run
  commands, bare or not. The `ext::` transport is always blocked.
- **Security**: sandboxed, context-isolated pages under a strict Content Security Policy, and an
  allowlisted IPC surface in which main supplies each tab's repository.
- **File watcher** that refreshes the view when the repository changes outside the app.
- **Keyboard shortcuts** for the common actions, and Open in Terminal.
- **Diagnostics**: local JSON-lines logs with credentials redacted, local crash reports, and Help →
  Copy Diagnostics.
- Checks at startup for git 2.51 or newer, including when the app is launched from Finder.
- A dark theme, and the Pasta Lite logo and app icon.
- **macOS DMG builds** for Apple silicon (arm64) and Intel (x64), signed with a Developer ID and
  notarized by Apple. `npm run dist:mac:unsigned` builds unsigned DMGs locally
  (CONTRIBUTING.md, "Building the macOS app").

### Known limitations

- No clone or init: open an existing repository.
- No credential prompts: authentication has to work without one, through an SSH agent or a
  credential helper. The app never shows a terminal prompt.
- No cherry-pick, revert or reset.
- No tags UI: tags are shown in the graph and the sidebar, but you can't create, delete or push
  them.
- Dark theme only.
- Tested on macOS only. Windows and Linux are untested, and there are no builds for them.
- No automatic updates: download new versions from the Releases page.
- Authentication has only been tested against a local server. Real HTTPS and SSH remotes and
  credential helpers have not been checked end to end yet.

[Unreleased]: https://github.com/SilverClash/pasta-lite-git-client/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/SilverClash/pasta-lite-git-client/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/SilverClash/pasta-lite-git-client/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/SilverClash/pasta-lite-git-client/releases/tag/v0.1.0
