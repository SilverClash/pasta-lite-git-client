# Pasta Lite: roadmap after rebase and merge

This plan covers what to build **after** the rebase and merge work in [rebase.md](rebase.md)
(R1–R5). It lists what Pasta Lite still lacks for daily use, picks the next features and puts
them in order.

Status: written 2026-09-25, while R1 was being built. Since then, R1–R3 of rebase.md have been
built, and so have a few items from this plan: tabs with restore on launch and the repository
picker (P6's "several repos", done as tabs), CI on macOS and Ubuntu (part of X1),
`protocol.ext.allow=never` on every git command (§3.4), and `mergetool.*` / `difftool.*` as risky
keys (§3.8). The rows below say **Done** for those. Everything else is still a plan.

**Sources.**
- The code, read directly: `src/ops.js` `OPS`, `src/git.js`, `src/undo.js`, `renderer/flows.js`
  `window.PLFlows`, `renderer/actions.js` `KEYS`, the context menus in
  `renderer/components/sidebar.js` and `graph-view.js`, and the `main.js` menus.
- The milestone 7 verification run: every flow driven through the `--smoke` harness in the real
  app, against a copy of this repository and a 20k-commit synthetic repo.
- git's own documentation for the commands each feature needs.

The "What users expect" column describes, in general terms, what someone using a graphical git
client needs from each feature. Every design choice here is made on its own merits: git's
semantics, safety, and the time it saves the user.

**Already planned. It is not re-planned here, only referred to.** These are all in
[rebase.md](rebase.md). R1–R3 are built; R4 and R5 are not:
- R1: the in-progress banner, Continue / Skip / Abort, the persistent autostash, conflict mode in
  the WIP panel
- R2: merge into current, Rebase X onto Y, Keep ours / Keep theirs per file, "Mark all resolved",
  the published-commits warning, the force-push follow-up, and `refMenuItems` shared by sidebar
  rows and graph pills
- R3: interactive rebase, and the reword and squash message dialog
- R4: drag and drop merge or rebase
- R5: undo and redo of rebase and merge (the record-commit pattern), progress events, and
  Reword / Drop / Squash in the graph (this also gives "Edit commit message" for HEAD on a clean
  tree)

**Size scale** (the same LOC style as rebase.md, tests included): **S** < 500 LOC, **M** 500–1,500,
**L** 1,500–3,000, **XL** > 3,000.
**Value:** H = a daily user hits it in the first week, M = weekly or for some users, L = rarely.

---

## 1. Feature gap inventory

**Status key:**
- **Done**: works in the app today.
- **Partial**: some of it is there, and the note says what's missing.
- **Missing**: not there at all.
- **Planned R*n***: covered by rebase.md.

The evidence is `file:function` in this repo.

### 1.1 Repo management, tabs and workspaces

| Feature | What users expect | Pasta Lite status (evidence) | Value | Effort | Deps | Recommendation |
|---|---|---|---|---|---|---|
| Open repo, recent repos | Open a folder, reopen recent repos, keep favorites | **Done** (`main.js` `showOpenDialog`, File > Open Recent; `src/recent.js`, max 10). No favorites | H | – | – | Favorites: **Won't do** (Recent is enough) |
| Clone | Clone from a URL into a chosen folder; shallow and sparse options for big repos | **Missing**. There is no `clone` anywhere in `src/` | H | M | Remote URL validation (P2), credential prompts (P3) | **Do next (P3)** |
| Init | Start a new repo with a default branch name, optionally with .gitignore and license templates | **Missing**. `openRepo` refuses a folder that isn't a repo (`not-a-repo`) | M | S | – | **Do next (P3)**, without templates at first |
| Several repos at once | Several repos open side by side, in tabs or windows, remembered across launches | **Done** as tabs: one repository per tab, reorderable (`main/tabs-controller.js`, `src/tab-session.js`, `renderer/tabs.js`) | H | – | – | Keep. Several windows: **Later**, only if asked |
| Restore the last repo on launch | The app reopens where the user left off | **Done**: the open tabs are saved to `tabs.json` and restored at the next start (`src/tabs-store.js`, `main/tabs-controller.js`) | M | – | – | – |
| Repository picker | Find a repository by typing, from recent repos and open tabs | **Done**: the start screen and the toolbar picker (⌘P) search recent repositories and open tabs (`renderer/components/repo-picker.js`) | H | – | – | – |
| Multi-repo workspaces and dashboards | Fetch or pull many repos at once; a PR and issue dashboard across them | **Missing** | L | XL | Accounts, integrations | **Won't do**: needs a vendor account or cloud service |
| Open in file manager / external editor | Jump from a repo or file to the file manager or the user's editor | **Missing**. Only Terminal exists (`shell.js` `terminalCommands`) | M | S | Settings for the editor path | **Later** (a quick win for P6) |

### 1.2 Graph and history

| Feature | What users expect | Pasta Lite status (evidence) | Value | Effort | Deps | Recommendation |
|---|---|---|---|---|---|---|
| Commit graph, paging, WIP row | Smooth scrolling through long histories, loaded as needed | **Done** (`graph-view.js`, `renderer/graph.js`). Capped at `LOG_MAX` = 10,000 (`ops.js`) | – | – | – | Keep |
| Commit search | Find a commit by message, sha or author, with a match count | **Missing**. The sidebar filter (⌘⌥F) filters refs only | H | M | – | **Do next (P4)** |
| Filter by author or team | Narrow the graph to one author or a group of authors | **Missing** | M | M | Search | **Later** (P4 stretch) |
| File history | The commits that touched one file | **Missing**. There is no `log --follow` | H | M | A centre file view | **Do next (P4)** |
| Blame | Who last changed each line, and in which commit | **Missing**. There is no `git blame` | H | M | File view | **Do next (P4)** |
| Hide and solo branches | Hide noisy branches or show only one, and see what is hidden | **Missing**. `git.log` always walks every tip (`currentTips`) | M | M | `log` tips option (already an arg) | **Later (P6)** |
| Graph column options | Choose which columns show (author, date, sha, changes, description); a compact graph | **Missing**. The columns are fixed (their widths can be resized) | L | S | Settings | **Later (P6)** |
| Pin to left, jump to pinned | Keep a chosen branch in the leftmost lane and jump to it | **Partial**. HEAD's chain is pinned to lane 0 (`store.js`), with no user pin | L | S | – | **Later** |
| Show all commits (no cap) | See every commit, even in very large repos | **Partial**. There is a 10k cap (`ops.js` `LOG_MAX`) | M | M | Performance work | **Later**: raise the cap once search exists |
| Avatars | A picture or initials next to each author | **Partial**. Initials only (`util.initials`), and nothing goes over the network | L | S | Network or privacy decision | **Won't do** by default (privacy); maybe an opt-in later |
| Diff: split, whitespace, word wrap, image diff | Split and inline views, ignore whitespace, word wrap, image comparison | **Partial**. Image preview and comparison built ([image-preview.md](image-preview.md)); split view, whitespace and word wrap still missing | M | M | – | **Later (P4 stretch)**: whitespace first (S) |
| Merge-commit diff | A merge's changes against each parent (`--diff-merges=separate`) | **Partial**. First parent only | L | S | – | **Later** |
| Compare a commit with the working dir, restore a file from a commit | Compare a commit with the working copy; restore one file as it was in a commit | **Missing** | M | S | – | **Do next (P1)**: restore file. Compare: **Later** |
| Copy branch name, sha, file path, link | Copy a sha, branch name, file path or a web link to the commit | **Partial**. Copy SHA exists in details (`details.js` `copyButton`) | L | S | – | **Later** (small, add with the P2 menus) |
| Edit the file in the app | Quick edits without leaving the app | **Missing** | L | L | – | **Won't do** (use the external editor) |

### 1.3 Commit and staging

| Feature | What users expect | Pasta Lite status (evidence) | Value | Effort | Deps | Recommendation |
|---|---|---|---|---|---|---|
| Stage and unstage by file, hunk or line; discard by file or hunk | Fine-grained staging and discarding | **Done** (`hunks.js`, `ops.stageSelection` / `discardSelection`, `diff-staging.js`) | – | – | – | Keep |
| Discard a line | Throw away a single changed line | **Done** (line selection, `hunks.discardSelection`) | – | – | – | – |
| Commit, amend, Commit All | Commit, amend, and commit everything in one step | **Done** (`git.commit({amend, only})`, `composer.js`) | – | – | – | – |
| Amend the message only on a clean tree | Fix the last commit's message with nothing staged | **Missing**. There is no WIP row on a clean tree | M | S | **Planned R5** (Reword / "Edit commit message") | Covered by R5 |
| Commit template | Start the message from a team template (`commit.template`) | **Missing** | L | S | Settings | **Later** (read `commit.template` into an empty summary: S) |
| Co-authors | Credit co-authors without typing the trailer by hand | **Missing** (only by typing the trailer into the message) | L | S | – | **Later** (a "Co-authored-by" helper in the composer) |
| GPG or SSH signing | Sign commits and tags by default (OpenPGP or SSH), and see who signed a commit | **Partial**. `git commit` respects the user's `commit.gpgSign` (pinentry or ssh-agent). There is no UI, and signatures are not shown (`exec.js` passes `log.showSignature=false`). `gpg.program` is a risky key (`git.riskyLocalConfig`) | M | M | Credential prompts (P3) for passphrases | **Later (P6)**: show signature status (M); signing settings (S) |
| Skip hooks | Skip hooks for one commit when they get in the way | **Missing**. Hooks always run; failures are classified (`hook-failed`) | L | S | – | **Later** (a checkbox → `--no-verify`) |
| Push after commit | Commit and push in one step | **Missing** | L | S | Settings | **Later** |
| Stash one file or selected files | Stash one file or a selection | **Missing**. `git.stashPush` always stashes everything (`--include-untracked`) | M | S | – | **Do next (P2)**: `stash push -- <paths>` |
| Stash keep-index, no untracked | Stash only unstaged changes, or leave untracked files out | **Missing** | L | S | – | **Later** |
| Edit a stash message | Rename a stash so it is easy to find later | **Missing** | L | S | – | **Later** |
| AI commit messages and commit restructuring | Generated commit messages, automatic commit splitting | **Missing** | – | – | – | **Won't do** |

### 1.4 Branches and tags

| Feature | What users expect | Pasta Lite status (evidence) | Value | Effort | Deps | Recommendation |
|---|---|---|---|---|---|---|
| Create, checkout, delete a local branch (with undo) | Everyday branch work, safely undoable | **Done** (`ops.createBranch` / `checkout` / `deleteBranch`, `undo.recordBranchDelete`) | – | – | – | – |
| Rename a branch | Rename from the branch's context menu | **Missing** | H | S | – | **Do next (P2)** |
| Delete a remote branch | Delete from one remote, from all remotes, or together with the local branch | **Missing** (the remote branch menu has Checkout / Create / Fetch: `sidebar.js` `branchMenuItems`) | H | S | – | **Do next (P2)** |
| Push to a chosen remote or branch | Push to a chosen remote or branch, or to all remotes | **Partial**. Push goes to the upstream, or asks for a remote when there is none (`flows.js` `pushNew`) | M | S | – | **Do next (P2)** |
| Set or change the upstream | Change which remote branch a branch tracks | **Done** (`flows.setUpstream`) | – | – | – | – |
| Fast-forward another branch | Bring another branch up to date without checking it out | **Missing** (R4's drag popup lists it) | M | S | **Planned R4** (popup) | Build the op in P2 so R4 can use it |
| Delete several branches, a folder of branches | Clean up many branches, or a whole prefix folder, at once | **Missing** | L | S | Multi-select | **Later** |
| Create a lightweight tag | Tag a commit | **Missing** (the tag menu has Checkout / Create branch here only) | H | S | – | **Do next (P2)** |
| Create an annotated tag | A tag with a message | **Missing** | H | S | A multi-line prompt (the R3 message dialog) | **Do next (P2)** |
| Delete a tag, push a tag, delete a tag from the remote | Manage tags locally and on the remote | **Missing**. `fetch` keeps local tags on conflict (`tagConflicts`), and that works | H | S | – | **Do next (P2)** |
| Gitflow | Start and finish feature / release / hotfix branches | **Missing** | L | L | – | **Won't do**: niche. Branch prefix folders already group `feature/` |

### 1.5 Remotes and network

| Feature | What users expect | Pasta Lite status (evidence) | Value | Effort | Deps | Recommendation |
|---|---|---|---|---|---|---|
| Fetch, pull (3 modes), push, force with lease, cancel | The core remote operations, cancellable | **Done** (`git.fetch` / `pull` / `push`, `flows.pushError`, `remoteOp` cancel) | – | – | – | – |
| Add, edit or remove a remote; several remotes | Manage remotes in the app, including a separate push URL and a fork's upstream | **Missing**. `flows.pickRemote` says "Add one from a terminal (git remote add origin <url>)" | H | M | URL validation | **Do next (P2)** |
| Prune | Deleted remote branches disappear on fetch | **Done** implicitly: `fetchRemote` always passes `--prune` (`git.js`). There is no setting | L | – | – | Keep; add a setting in P6 if asked |
| Auto-fetch | Remote state stays current without pressing Fetch | **Missing** | M | S | Settings, credential prompts (must not prompt from a timer) | **Do next (P3)** |
| Credential and passphrase prompts | The app asks for whatever git needs (via GIT_ASKPASS / SSH_ASKPASS): SSH key passphrase, username + password or PAT, unknown host key and invalid TLS certificate prompts | **Missing**. `GIT_TERMINAL_PROMPT=0` (`exec.js`), and `auth` errors become an alert (`flows.authAlert`). This works only with a credential helper or ssh-agent | H | L | A helper runner (the same as the R1 editor helper) | **Do next (P3)** |
| OAuth to GitHub or GitLab, SSH key generation | Connect a hosting account; generate an SSH key and register it with the host | **Missing** | M | L | Integrations | **Later (P7)**, only if the user wants hosting integrations |

### 1.6 Commit surgery

| Feature | What users expect | Pasta Lite status (evidence) | Value | Effort | Deps | Recommendation |
|---|---|---|---|---|---|---|
| Cherry-pick | Copy one or several commits onto the current branch, with local changes stashed around it | **Missing**. `op-model.js` only *detects* `cherry-picking` / `sequencer` state | H | M | R1 banner, R2 menus | **Do next (P1)** |
| Revert | Undo a commit with a new commit, with local changes stashed around it | **Missing** (`reverting` is detected only) | H | M | Same as cherry-pick | **Do next (P1)** |
| Reset to a commit | Soft / Mixed / Hard from the commit menu, and undoable | **Missing**. Only pull failures use `reset --hard` internally (`git.withAutostash`) | H | M | The R5 undo record pattern | **Do next (P1)** |
| Undo scope | Undo for every action that moves a ref or drops work: checkout, commit, discard, branch and remote deletion, reset, rebase | **Partial**. commit, checkout, discard, delete_branch (`undo.js` `parseAction`); rebase and merge are **Planned R5** | M | – | – | P1 adds reset and cherry-pick / revert; P2 adds delete_tag |
| Create or apply a patch | Save commits as a patch, or apply one | **Missing** | L | S | – | **Later** |
| Cloud-shared patches, code suggestions | Share work in progress or suggest changes through a hosted service | **Missing** | – | – | – | **Won't do** (cloud) |

### 1.7 Conflicts

| Feature | What users expect | Pasta Lite status (evidence) | Value | Effort | Deps | Recommendation |
|---|---|---|---|---|---|---|
| List conflicts, Mark resolved, read-only conflict diff | See which files conflict and mark them resolved | **Done** (`details.js` "Mark resolved", combined conflict diff in `diff-view.js`) | – | – | – | – |
| Take current or incoming per file | Take one side for a file, or for several files | **Done** in R2 (`ops.resolveWith`, `flows-op.js` `resolveWith`) | – | – | – | – |
| External merge tool | Open a conflicted file in the user's own merge tool | **Missing** | M | S | Trust keys (`mergetool.*.cmd`) | **Do next (P5a)** |
| 3-way merge editor | Both sides plus an editable result, take a line or a whole side, a conflict counter, save | **Missing** (rebase.md §13) | H | XL | R1 conflict mode | **Do next (P5b)**, after P1–P4 |
| Proactive conflict detection | An early warning when a branch will conflict with its target or PR base | **Missing** | L | M | `git merge-tree --write-tree` | **Later** (cheap with `merge-tree`, but low value) |

### 1.8 Submodules, LFS, worktrees, hooks, sparse checkout

| Feature | What users expect | Pasta Lite status (evidence) | Value | Effort | Deps | Recommendation |
|---|---|---|---|---|---|---|
| Submodules | See, open, init and update submodules | **Partial**, and only as safety: the watcher maps gitlinks (`watcher.js`), and hunk ops refuse submodules (kind `submodule`). There is no UI | M | L | Tabs or windows (to open one) | **Later** (first "Open submodule" in a new window: S, after P6) |
| Git LFS | Init, track patterns, and fetch / pull / push / prune LFS objects | **Missing**. The watcher only prunes `.git/lfs`. LFS filters run if git-lfs is installed, since normal git runs them | M | M | – | **Later**: detect LFS, and show "LFS not installed" clearly (S) |
| Worktrees | Create, open, lock, remove and prune linked worktrees | **Partial**. Built: the sidebar list (branch or SHA, main, current, locked, missing and dirty states; `ops.worktrees`, `ops.worktreeDirty`), open (`app:openWorktree`), delete (`ops.removeWorktree`, refused while a rebase or merge is stopped there or a write runs there; `ops.worktreeUnreachable` for the detached-HEAD warning), prune (`ops.pruneWorktrees`), lock / unlock (`ops.lockWorktree`, `ops.unlockWorktree`), reveal (`app:revealWorktree`) and copy path. A bare repository's banner still lists its worktrees. Create, move, repair, orphan and open in a new window are not built | M | M | – | **Later**: create (the main gap), move, repair, orphan, open in a new window |
| Hooks UI | Pick the hooks folder; see why a hook failed | **Partial**. Hooks run, and failures are shown (`hook-failed` dialog). There is no UI to set `core.hooksPath` | L | S | – | **Won't do** (configure hooks in git) |
| Sparse checkout, shallow clone | Work with part of a huge repo | **Missing** | L | M | Clone | **Won't do** for now (shallow clone: maybe a P3 option) |

### 1.9 Integrations

| Feature | What users expect | Pasta Lite status (evidence) | Value | Effort | Deps | Recommendation |
|---|---|---|---|---|---|---|
| GitHub / GitLab / Bitbucket / Azure DevOps (+ Enterprise / self-managed): PRs, PR view, merge, reviews | Open, review, filter and merge PRs without leaving the app | **Missing** | M–H (teams) | XL each | OAuth, token storage | **P7, conditional**. First step: "Push and open a PR in the browser" (S, no auth) |
| Issues (GitHub, GitLab, Jira, Trello) | See and link issues from the tracker | **Missing** | L | XL | – | **Won't do** |
| Clone from hosting (repo picker) | Pick a repo from a connected account and clone it | **Missing** | M | L | OAuth | **Later (P7)**. Clone by URL comes in P3 |
| AI assistants and agents | Generated summaries and automated changes | – | – | – | – | **Won't do** |

### 1.10 App shell: terminal, palette, settings, themes, keys

| Feature | What users expect | Pasta Lite status (evidence) | Value | Effort | Deps | Recommendation |
|---|---|---|---|---|---|---|
| Terminal | A terminal at the repo, built in or external | **Partial**. External terminal only (`shell.terminalCommands`, `flows.openTerminal`) | L | L (native module) | – | **Won't do** built-in. External terminal choice goes in P6 settings |
| Command palette | Reach any action by typing (checkout, open file history or blame, create tag…) | **Missing** | M | M | KEYS table, flows (already one registry) | **Later (P6)**: a good multiplier once P1–P4 exist |
| Settings / Preferences UI | One place for preferences, global and per repo | **Missing**. Only localStorage for the pull mode, collapse state and drafts | M | M | – | **Do next (P6)** |
| Git identity | Set the author name and email, per repo or globally | **Missing**. It uses the user's gitconfig; a commit without `user.name` fails with git's message | M | S | Settings | **Do next (P6)**: set a per-repo or global identity when commit fails |
| Themes | Dark, light, or follow the system | **Partial**. Dark only, but every colour is a `:root` token (`style.css`) | M | S | Settings | **Do next (P6)**: light + system (cheap thanks to the tokens) |
| Profiles | Switch between sets of identity and settings (work / personal) | **Missing** | L | M | Accounts | **Won't do** |
| Custom keyboard shortcuts | A list of the shortcuts, and a way to change them | **Partial**. One fixed table (`renderer/keys.js` `KEYS`); tooltips show the hints | L | S (a help sheet) / M (remap) | Settings | **Later**: a shortcut help sheet (S); remapping only if asked |
| Desktop notifications | A notice when a long operation finishes while the window is in the background | **Missing**. In-app toasts only | L | S | – | **Later** (notify when a long remote op finishes while the window is unfocused) |
| Accessibility | Full keyboard use and screen-reader support | **Partial**. ARIA grid on the graph, roles on menus and dialogs, one focus ring, keyboard tree in the sidebar. Not tested with a screen reader | M | M | – | **Later**: a VoiceOver / NVDA audit pass (X8) |
| i18n | The UI in the user's language, and their date format | English only | L | L | – | **Won't do**; a date format setting could come in P6 |
| Undo / redo | Undo the last action with one key | **Done** for commit, checkout, discard and branch delete (`src/undo.js`) | – | – | – | – |

### 1.11 Production and non-functional

| Item | What users expect | Pasta Lite status (evidence) | Value | Effort | Recommendation |
|---|---|---|---|---|---|
| Packaging, code signing, notarization | Signed, installable builds for macOS, Windows and Linux | **Missing**. `package.json` has no build tooling and runs `electron .` | H | M | **X2**, starts now in parallel |
| Auto-update | Updates found and installed from inside the app | **Missing** | H | M | **X3**, after X2 |
| CI on 3 OSes | – | **Partial**. `.github/workflows/test.yml` runs `npm test` on macOS and Ubuntu (Node 22 on both, Node 24 on Ubuntu; git from Homebrew / the git-core PPA). No Windows job and no smoke run | H | S | **X1**: add Windows |
| Bundled git | Works on a machine with no git, or an old one | Requires system git ≥ 2.51 (`gitcheck.findGit`) | M | M | Open question Q5 |
| Performance on huge repos | Stays fast on huge histories, with search across all of them | 20k commits verified in the milestone 7 run; the log is capped at 10k (`LOG_MAX`, `src/ops.js`) | M | M | **Later** (after search). Keep the 10k cap until then |
| Telemetry, crash upload | Crashes get fixed, without surprise data collection | Local only: logs, Crashpad dumps, Copy Diagnostics (`src/log.js`, `src/diagnostics.js`). `uploadToServer: false` | L | S–M | **X7: Won't do** unless you ask; opt-in only |
| Discard-backup and record-ref pruning | – | **Missing**: nothing prunes `refs/pasta-lite/backups/*` yet (rebase.md §13) | M | S | **X6** (before 1.0) |
| Real network auth testing | – | Only a local 401 server (a gap the milestone 7 run left) | H | S (manual matrix) | **X4**, with P3 |

---

## 2. Top priorities (after R1–R5)

These are ranked by value ÷ effort, weighted by what a solo or team user hits first. The M7
verification gaps and what v1 left out set the list: no cherry-pick / revert / reset, no tags, no remote
management, no real auth prompts, one repo at a time, no file history, blame or search, no
conflict editor, and no packaging.

| Rank | Feature | Value | Size | Why this rank |
|---|---|---|---|---|
| 1 | **Cherry-pick and revert** from the graph | H | M | These are the most common "fix history" actions after rebase, and today they need a terminal. They reuse all of R1: the banner, Continue / Skip / Abort, autostash and conflict mode. `op-model.js` already names these states |
| 2 | **Reset branch to commit** (Soft / Mixed / Hard) with undo, plus "Restore file from this commit" | H | M | The other daily graph action. A hard reset is the most destructive op a user can make, so it ships with a worktree backup and undo (the discard backup plus the R5 record pattern) |
| 3 | **Tags**: create lightweight or annotated, delete (undoable), push, delete from remote | H | S–M | Release workflows need them. They are cheap because refs, fetch-tag conflicts and the push plumbing exist, and they are all ref ops with no worktree impact |
| 4 | **Branch and remote housekeeping**: rename branch, delete remote branch, push to…, fast-forward a branch, add / edit / rename / remove remote, stash selected files | H | M | Every team user needs to delete merged remote branches and add a second remote (fork workflows). Today the app sends them to a terminal. It also builds the URL validation that clone needs |
| 5 | **Credential prompts** (HTTPS user + password / PAT, SSH key passphrase, unknown host key) | H | L | The biggest "works in the demo, fails on my machine" risk. Without a credential helper or ssh-agent, every remote op fails with `auth`. It also unblocks clone and auto-fetch |
| 6 | **Clone, Init, auto-fetch** | H | M | Onboarding. Clone is the first thing a new user tries, and auto-fetch keeps ahead/behind honest for teams. All three depend on #4 (URLs) and #5 (auth) |
| 7 | **Commit search, file history, blame** | H | L | The three read-only "why is this code like this" tools. One shared piece, a centre file view, serves both history and blame |
| 8 | ~~**Several repos: one repo per window**, then restore windows on launch~~ | H | M | **Done** as tabs, restored on launch (§1.1). Several windows are not planned |
| 9 | **Settings UI + light / system theme + identity + external tools** | M | M | Many items above need a home (auto-fetch interval, merge tool, editor, terminal, theme, graph options). The theme is almost free thanks to the tokens |
| 10 | **Conflict resolution**: external merge tool (P5a, S), then the in-app 3-way editor (P5b, XL) | H | S + XL | High value, but R2's Keep ours / theirs plus Mark resolved already cover the common case. The XL editor goes after the cheaper items. The external tool is a small bridge for early use |

**The production track runs beside the features** (see §5). CI (X1) and packaging and signing
(X2) should start **now**, not after P6. Nobody can use the app daily without an installable,
signed build, and CI is what makes the Windows and Linux promises real.

**Left out of the top 10, with reasons:**
- Hosting integrations: XL, and they depend on your answer to Q1.
- Submodules, LFS and worktrees: M–L each, and they need several windows first.
- Command palette: most useful once P1–P4 have added enough actions.
- Hide and solo branches: M value.
- Gitflow, built-in terminal, AI and cloud features: won't do.

---

## 3. Mini-specs for each priority

The existing contracts apply throughout:
- `ops.OPS` has a `check` step (refusals touch nothing and emit nothing) and a queued write
  (`busy` / `changed` events).
- `err.kind` values (user-facing ones are added to `Components.util.EXPECTED_KINDS`).
- `window.PLFlows` flows resolve `true` only on success and never throw.
- `Components.actions` menu descriptors go through `finishItems` + `gateItems`. New starts go in
  `START_FLOWS`, so they are disabled while an op is in progress.
- `Components.dialog.prompt` / `choose` / `confirm`, with Cancel focused for danger dialogs.
- `KEYS` is the one keybinding table.
- Menus go through `Components.menu` (it has **no submenus**: pick modes with `choose`).
- Everything follows the git conventions of `src/git-process.js` (`GLOBAL_ARGS`, the env
  allowlist), and messages go on stdin.

### 3.1 P1a: Cherry-pick and revert

**Scope.**
- Cherry-pick one commit, or several in graph order, onto the current branch.
- Revert one commit that is in HEAD's history.
- Merge commits:
  - Cherry-pick refuses them (kind `merge-commit`).
  - Revert of a merge asks "Revert against the first parent?" and then uses `-m 1`.
- Autostash uses R1's persistent autostash.
- Conflicts stop into the R1 banner, with Continue / Skip / Abort.
- Out of scope: interactive cherry-pick (rebase.md §13) and "cherry-pick without committing".

**UX entry points.**
- Graph commit menu (`graph-view.js` `commitMenuItems`):
  - "Cherry-pick commit": for commits that are not ancestors of HEAD, using R2's
    `store.headAncestors()`.
  - "Revert commit": for ancestors of HEAD. It is disabled for the root commit, with a title.
- Graph ref pill and sidebar branch menu: "Cherry-pick <b>'s tip into <cur>".
- Multi-select ("Cherry pick {n} commits") waits for a multi-select graph, which rebase.md also
  defers.
- The R1 banner gets a sequencer variant:
  - "Cherry-picking <sha7> <subject> onto <cur>" / "Reverting …"
  - **Continue**, **Skip Commit**, **Abort**
- Flows:
  - `PLFlows.cherryPick(store, {commits})` and `PLFlows.revert(store, {commits})`: `START_FLOWS`.
  - `sequencerContinue`, `sequencerSkip`, `sequencerAbort`: gated to the matching `status.state`.
- Notices: "Cherry-picked <sha7> onto main" and "Reverted <sha7>".
- No KEYS entry.

**Backend ops** (in `src/sequencer.js`, a new file next to `rebase.js`):

```js
cherryPick(commits: sha[], {autostash = true, expectHead}) -> SeqResult
revert(commits: sha[], {mainline?: 1, autostash = true, expectHead}) -> SeqResult
sequencerContinue({message?}) -> SeqResult      // state cherry-picking | reverting | sequencer
sequencerSkip() -> SeqResult
sequencerAbort() -> {status: 'aborted', stash?}
SeqResult = {status: 'done', before, after, created: [sha], undoRecorded, stash?}
          | {status: 'stopped', state}           // conflict or empty-pick stop
          | {status: 'empty'}                    // every pick was already applied
```

**Checks (refusals).**
- `in-progress`: state is not clean.
- `invalid-args`: not a full sha, or not a commit.
- `merge-commit`: cherry-pick of a merge.
- `not-in-branch`: revert of a commit that is not an ancestor of HEAD (`merge-base --is-ancestor`).
- `root-commit`: revert of the root commit.
- `stale`: `expectHead` ≠ HEAD.
- `too-many`: more than 100 commits.

**Git commands.**
- Global invocation as rebase.md §3.1: `GIT_EDITOR` set to the constant helper, or
  `-c core.editor=true` with `--no-edit`.
- Cherry-pick: `git cherry-pick --no-edit --allow-empty-message --empty=stop -- <sha>...`. The
  backend sorts the shas oldest first with `rev-list --no-walk=sorted --reverse` (to verify).
  `--empty=stop` is present in git 2.51.2 (checked with `cherry-pick -h`).
- Revert: `git revert --no-edit [-m 1] <sha>...`.
- Continue: `cherry-pick --continue` / `revert --continue` with the message through the R1
  message helper. Skip: `--skip`. Abort: `--abort`.
- The state is read from `CHERRY_PICK_HEAD`, `REVERT_HEAD` and `sequencer/todo`, extending
  `exec.repoState`. The status gets `status.sequencer = {op, current: sha, remaining: n}`.

**Undo.**
- When a run finishes, write the R5 record commit
  (`{branch, before, after, op: 'cherry-pick' | 'revert'}`), kept alive by
  `refs/pasta-lite/records/<record>`, plus the reflog entry
  `cherry-pick: [<record>] <branch>` / `revert: [<record>] <branch>`.
- Undo and redo reuse the R5 two-tree handler: clean worktree, tip == after, then
  `read-tree -m -u` plus `update-ref`.
- git's own `cherry-pick: <subject>` entries made by a terminal count as commit-like single steps
  (the tip moves back one parent, as commit undo does).

**Security.**
- Shas only. The renderer never sends a message except on Continue.
- Hooks and signing run inside git, as in rebase.md §3.9.

**Testing.**
- `test/sequencer.test.js` against scratch repos:
  - a clean pick; several picks in order
  - a conflict stop, then Continue, Skip or Abort
  - an empty pick, and all already applied
  - merge refused; revert of a merge with `-m 1`
  - autostash across a stop
  - `hostileConfig`
  - a terminal-started cherry-pick seen by `status`
- `ops.test.js`: refusals.
- `flows.test.js`: each branch.
- `rebase-banner.test.js`: the sequencer variant.
- `undo.test.js`: the record and git's own entries.

**Acceptance criteria.**
- From the graph menu, a cherry-pick of a commit from another branch produces exactly one new
  commit, with the same message and author (committer = user).
- A conflict shows the banner, and Continue after Mark resolved finishes the run.
- Abort restores HEAD and the autostashed changes.
- ⌘Z undoes the whole run.
- Revert of HEAD~2 creates a "Revert "…"" commit.
- Terminal-started cherry-picks show the banner.

**Size:** M (~1.3k LOC).

**Risks.**
- Sequencer edge cases, such as a cherry-pick of several commits interrupted by a terminal.
- `--empty` semantics differ between cherry-pick and revert.
- The ours/theirs labels during conflicts: reuse R2's side naming.

### 3.2 P1b: Reset to commit, and restore a file from a commit

**Scope.**
- "Reset <cur> to this commit" in three modes: Soft, Mixed, Hard.
- Reset to an upstream or a tag through the ref menus.
- "Restore file from this commit" (`checkout <sha> -- <path>`) from a commit's file list.

**UX.**
- Graph commit menu: "Reset <cur> to this commit…" opens `dialog.choose` with three choices:
  - "Soft: keep all changes staged"
  - "Mixed: keep changes unstaged"
  - "Hard: discard all changes" (danger)
- If commits would leave the branch and are on a remote-tracking ref, a second danger confirm
  warns: "3 commits are already on origin/main; you'll need to force push". This reuses R2's
  `published` computation.
- Hard reset with local changes lists the dirty files and says "they can be restored with Undo".
- Commit file list (`details.js`) context menu: "Restore this file from <sha7>". It is a danger
  confirm when the working copy differs, and it is undoable.
- Flows: `PLFlows.reset(store, {target})` and `PLFlows.restoreFile(store, {commit, path})`.

**Backend ops.**

```js
reset(target: sha, {mode: 'soft'|'mixed'|'hard', expectHead}) -> {before, after, mode, backup?: sha, undoRecorded}
restoreFile(commit: sha, path: relPath) -> {path, backup}    // wrapped in undo.withDiscardBackup([path])
```

**Checks.**
- `in-progress`.
- `stale` (expectHead).
- `invalid-args` (mode not in the whitelist, target not a commit).
- `nothing` (target == HEAD with mode soft or mixed and a clean index).
- `not-found`: the path is not in that commit (`cat-file -e <sha>:<path>`).

**Git commands.**
- Soft and mixed: `git reset --soft|--mixed -q <sha>`. Mixed passes `--no-refresh`? Measure first.
- Hard: first `undo.snapshotTree` of every tracked changed path (the discard backup machinery:
  before/after pair, `refs/pasta-lite/backups/<after>`), then `git reset --hard -q <sha>`.
  Untracked files are untouched, since reset never removes them. Verify that with ignored and
  untracked files.
- The record commit for the undo holds `{branch, before, after, mode, indexTree}`. `indexTree`
  comes from `write-tree` before the reset (for mixed). The reflog entry is
  `reset: [<record>] <mode> <branch>`.

**Undo.**
- Soft: `update-ref` back to before.
- Mixed: `update-ref`, then `read-tree <indexTree>`.
- Hard:
  - Requires a clean worktree (else `undoBlocked` "Commit or stash your changes first").
  - Runs `read-tree -m -u <after> <before>`, `update-ref`, then restores the backup snapshot
    (`applyDiscard`).
  - It is not cancellable (as today) and needs a test for each step failing.
- Redo is the mirror.
- git's own `reset: moving to <x>` entries (from a terminal) are **not** undoable: they can't be
  known to be safe. They stop the walk, as today.

**Testing.**
- `test/reset.test.js`: the three modes; hard with staged, unstaged and untracked changes; undo
  and redo of each; hostile config; a detached HEAD.
- `undo.test.js`: the walk with reset records mixed with commits.
- `flows.test.js`: the choose dialog and the published warning.

**Acceptance criteria.**
- A hard reset with dirty files, then ⌘Z, gives back the exact pre-reset tree, index and HEAD.
- Soft reset, then ⌘Z, gives back HEAD with the index unchanged.
- A warning appears when published commits would be dropped.

**Size:** M (~1.1k LOC).

**Risks.**
- The interaction between the backup snapshot and filters or autocrlf. The M1 review already
  solved this with raw blobs.
- A large worktree makes the snapshot slow. Show the busy state, and measure on the 20k repo.

### 3.3 P2a: Tags

**Scope.**
- Create a lightweight or annotated tag at a commit.
- Delete a local tag (undoable).
- Push one tag to a remote.
- Delete a tag from a remote.
- Copy the tag name.
- Signed tags follow the user's `tag.gpgSign`.

**UX.**
- Graph commit menu: "Create tag here…" and "Create annotated tag here…".
- Sidebar tag menu (`sidebar.js` `branchMenuItems`, kind `tag`):
  - Checkout
  - Create branch here…
  - Push to <remote> (one item per remote, or "Push to…" with `pickRemote`)
  - Delete (danger; mentions Undo)
  - Delete from <remote>… (danger, not undoable)
  - Copy tag name
- Name prompt: `dialog.prompt` with `tagNameError(name, refs)` (pure, like `branchNameError`).
- Annotated tags need a multi-line message. Reuse R3's reword message dialog, or add
  `prompt({multiline: true})` to the dialog contract.
- Notices: "Created tag v1.2 at <sha7>" and "Pushed tag v1.2 to origin".
- The details panel shows the annotation when a tag's commit is selected. That is **Later**.

**Backend ops.**

```js
createTag(name, target: sha, {message?}) -> {name, sha, annotated}
deleteTag(name) -> {name, sha, undoRecorded}                 // reflog: delete_tag: <name> [<tag-object-or-commit sha>]
pushTag(name, remote) -> {remote, name}
deleteRemoteTag(name, remote) -> {remote, name}
```

**Checks.**
- The name goes through `check-ref-format "refs/tags/<name>"` and may not start with `-`.
- `exists` for a local tag that already exists. `not-found`.
- The remote must be configured (the existing `remoteName`).

**Git commands.**
- `tag <name> <sha>`, or `tag -a -F - <name> <sha>` with the message on stdin (`--cleanup=whitespace`).
- `tag -d <name>`, after reading the peeled and unpeeled oid for undo.
- Push: `push --porcelain <remote> refs/tags/<t>:refs/tags/<t>`. It never forces, so a rejection
  is kind `rejected-exists` ("origin already has a different v1.2").
- Delete from remote: `push --porcelain <remote> :refs/tags/<t>`, under `remoteOp` (cancellable).

**Undo.**
- New action `delete_tag` in `undo.js` `parseAction`.
- Undo: `update-ref refs/tags/<name> <sha>`, where `sha` is the tag *object*, so an annotated tag
  comes back exactly. The check is `objectExists` and that the tag is still absent.
- Redo deletes it again.
- Create tag stays not undoable, since deleting is its own action. Decide in review.

**Security.**
- Tag names come from the renderer, so validate them as ref names.
- The message goes on stdin. `refs.tags` display text goes through `displayName`.

**Testing.**
- `git.test.js`:
  - create, both kinds
  - annotated message with `#` and unicode
  - a push to a bare remote
  - a rejected push of a differing tag
  - a remote delete
  - hostile `tag.sort` / `tag.gpgSign=false`
- `undo.test.js` (delete_tag), `flows.test.js`, `sidebar-actions.test.js` (menus).

**Acceptance criteria.**
- Create an annotated tag in the app, push it, and `git ls-remote --tags` shows it with the same
  object.
- Delete it, ⌘Z, and it is back as the same object.

**Size:** S–M (~700 LOC).

**Risks.** Almost none. The prompt contract change must be kept compatible.

### 3.4 P2b: Branch and remote housekeeping

**Scope.**
- Rename a local branch.
- Delete a remote branch, with a lease.
- Push a branch to a chosen remote or branch.
- Fast-forward a local branch that isn't checked out to its upstream or to a ref (R4's popup
  item).
- Add, edit (fetch and push URL), rename and remove a remote.
- Stash selected files.

**UX.**
- Sidebar local branch menu: Rename…, Push to…, "Fast-forward to <upstream>" (only when strictly
  behind).
- Sidebar remote branch menu: "Delete <b> from <remote>…" (danger), Copy name.
- The sidebar REMOTE header gets a "+" button (Add remote…).
- The remote node menu: Fetch, Edit URL…, Rename…, Remove… (danger).
- WIP file rows (multi-select): "Stash N files…".
- `pickRemote`'s "No remotes" alert offers **Add Remote…** in place of the terminal hint
  (`flows.js`).
- The add-remote dialog is one prompt for the name and one for the URL. A two-field form dialog
  is a new `dialog.form({fields})` contract, useful for clone too.

**Backend ops.**

```js
renameBranch(old, name) -> {old, name}                   // branch -m; refuses exists, not-found
deleteRemoteBranch(remote, branch) -> {remote, branch, sha}
pushTo({branch, remote, remoteBranch, setUpstream?}) -> push result   // extends git.push
fastForward(branch, target) -> {branch, before, after}   // update-ref after merge-base --is-ancestor
addRemote(name, url, {fetch = true}) -> {name}
setRemoteUrl(name, url, {push = false}) -> {name}
renameRemote(old, name) -> {old, name}
removeRemote(name) -> {name, url, undoRecorded}          // record: remove_remote, Later
stashPush(message, {paths?}) -> …                        // extends the existing op
```

**Git commands.**
- `branch -m -- <old> <new>`, which also moves `branch.<old>.*` config.
- `push --porcelain --force-with-lease=refs/heads/<b>:<oid-of-remote-tracking> <remote> :refs/heads/<b>`.
  A remote that moved since the last fetch gives `rejected-stale`, and the flow offers Fetch.
- Fast-forward: `merge-base --is-ancestor <branch> <target>`, then
  `update-ref -m "fast-forward" refs/heads/<b> <new> <old>`. If the branch is checked out, use
  `merge --ff-only`. Also reject a branch checked out in another worktree (kind
  `checked-out-elsewhere`, as in rebase.md).
- Remotes: `remote add <name> <url>`, `remote set-url [--push] <name> <url>`,
  `remote rename <old> <new>`, `remote remove <name>`.
- Stash: `stash push --include-untracked -m <msg> --pathspec-from-file=- --pathspec-file-nul`.

**URL validation** (shared with clone, `src/urls.js`, pure):
- Accept `https://`, `http://` (with a warning), `ssh://`, scp-like `user@host:path`, `git://`,
  and an absolute local path or `file://` (for local bare remotes, as in the M7 tests).
- Refuse:
  - a leading `-`
  - `ext::`, `fd::` and other `<transport>::` helper syntax
  - control characters
  - URLs with an embedded password. Warn "Tokens in URLs are stored in plain text in .git/config"
    and refuse by default. `redact.js` already scrubs them from logs.
- **Done:** `-c protocol.ext.allow=never` is passed on every git command, not only remote ops
  (`GLOBAL_ARGS` in `src/git-process.js`), as defence in depth. The command line wins over every
  config file, and child gits inherit it.

**Undo.**
- Rename branch and remote ops: not undoable in the first cut, and the confirm says so.
- `remove_remote` undo is **Later**. It needs the remote's config section and
  its tracking refs recorded.

**Testing.**
- `git.test.js`:
  - rename keeps the upstream config
  - remote delete with the lease (moved → refused)
  - fast-forward refusals (not an ancestor, checked out elsewhere)
  - each remote op, and the URL validator table (`urls.test.js`)
  - stash of selected paths, including untracked ones
- `flows.test.js`, `sidebar-actions.test.js`.

**Acceptance criteria.**
- Add `upstream` pointing at a fork's parent, fetch it, and its branches appear.
- Delete `origin/feat` from the menu, and it is gone on the bare remote.
- Rename `feat` to `feat2`, and the upstream is still set.

**Size:** M (~1.4k LOC).

**Risks.**
- Deleting a remote branch that is the remote's default branch: refuse when `refs/remotes/<r>/HEAD`
  points at it.
- Windows paths in local URLs.

### 3.5 P3a: Credential and passphrase prompts

**Scope.**
- When git or ssh need a secret and no helper or agent provides one, ask in the app:
  - HTTPS username, password or PAT
  - SSH key passphrase
  - SSH unknown-host confirmation, with the fingerprint shown
  - a GPG passphrase only if pinentry is unavailable. That is **Later**: pinentry-mac normally
    covers it.
- The user's credential helper and ssh-agent always come first. We never override the user's
  `credential.helper`: it already holds their saved credentials.

**Design.**
- `GIT_ASKPASS` and `SSH_ASKPASS` point at a **constant** helper command, the same runner as
  rebase.md's editor helper (`"$PL_NODE" "$PL_ASKPASS_HELPER"`). Set `SSH_ASKPASS_REQUIRE=force`,
  plus `DISPLAY` on Linux if it is unset.
- The helper connects to a per-launch local socket (a Unix domain socket in a private `0700`
  folder under the user's temp or runtime dir; a named pipe on Windows).
- The path and a random 256-bit token reach the helper **only through env** (`PL_ASKPASS_SOCK`,
  `PL_ASKPASS_TOKEN`).
- Main checks the token, and accepts prompts only while one of our remote ops is running for that
  repo (bound by opId, which goes into the helper env).
- Main sorts the prompt text (`Username for 'https://host':`, `Password for 'https://u@host':`,
  `Enter passphrase for key '/path':`, `Are you sure you want to continue connecting`) into
  `{kind: 'username'|'password'|'passphrase'|'hostkey', host, user?, keyPath?, fingerprint?}`.
- Main sends the renderer an `app:credential-request` event. The renderer shows a modal
  (password field, "Remember" when a credential helper is configured), and replies over
  `app:credential-reply {id, value | null}`. The helper prints the value and exits 0, or exits 1
  on cancel.
- "Remember" runs `git credential approve` into the user's configured helper. We never store
  secrets ourselves.

**Security.**
- The secret is never logged. `redact.js` already treats the fields as secrets, and the reply is
  kept out of `app:log`.
- It is zeroed after use and never sent to any other window.
- Prompts are rate-limited, one at a time.
- An unknown host key shows the fingerprint and defaults to Cancel.
- Refuse prompts that arrive while no op of ours is running.
- `core.askPass`, `core.sshCommand` and `credential.*helper` in local config are already risky keys
  (`RISKY_CONFIG`, `src/git.js`).

**Ops and errors.**
- There are no new ops. `remoteOp` gains an `askpass` env scope.
- New kinds: `auth-cancelled`, which is quiet.
- `auth` stays for a real failure. The flows retry once after a prompt-driven failure: git itself
  re-asks on a bad password.

**Testing.**
- Helper unit tests with a fake socket: token refused, cancel, timeout.
- The local HTTP 401 server (existing) with basic auth: a correct and a wrong password.
- A local `sshd` in CI on Linux only, for a passphrase-protected key (optional job).
- **X4 manual matrix**:
  - GitHub HTTPS with a PAT and with no helper
  - GitHub SSH with the key not in the agent
  - GitLab HTTPS
  - a self-hosted remote with a new host key
  - macOS, Windows (OpenSSH and plink), Linux

**Acceptance criteria.** With no credential helper and an empty ssh-agent, fetch, pull, push and
clone of a private GitHub repo work over both HTTPS (PAT) and SSH (passphrase), after one prompt
each.

**Size:** L (~1.8k LOC).

**Risks.**
- Windows named pipes, and ssh variants (plink, TortoisePlink).
- Git Credential Manager showing its own UI: detect `credential.helper=manager` and stay out of
  the way.
- Electron's `RunAsNode` fuse: X2 must not disable it while helpers rely on `ELECTRON_RUN_AS_NODE`.
  Otherwise ship a tiny helper binary. This is shared with rebase.md's editor helper.

### 3.6 P3b: Clone, Init, auto-fetch

**Scope.**
- Clone by URL into a chosen folder, with progress and Cancel. Optional `--depth` (the shallow
  clone the strings list), **Later**.
- Init in a chosen folder with a default branch name.
- Auto-fetch every N minutes.

**UX.**
- Welcome screen and the File menu get "Clone Repository…" and "New Repository…".
- Clone uses `dialog.form` (URL, parent folder chosen with the native picker through a new
  `app:pickFolder`, folder name derived from the URL).
- Progress shows in the toolbar busy area ("Receiving objects 45%"), with Cancel.
- The repo opens when the clone is done, through the normal `openRepo` and trust check.
- Auto-fetch: a per-repo setting (P6), off by default. Open question Q6.
  - Runs `fetch` quietly (`{quiet: true}`) only while the window is focused or was focused in the
    last N minutes.
  - Never while a write is queued.
  - Never prompts: it passes a `noPrompt` flag, and an `auth` failure shows once as "Auto-fetch
    failed: fetch manually to sign in".

**Backend.** These are app-level IPC handlers, not `OPS`, because there is no repo yet:
- `app:clone({url, parent, name, depth?}, opId)`:
  - Runs `git clone --progress --no-recurse-submodules -- <url> <parent>/<name>` with no timeout
    except cancel.
  - Progress comes from stderr `\r` frames, sent as `progress` events.
  - Checks: the URL (§3.4 validator), `parent` absolute and existing, `name` a single path segment
    and not existing.
- `app:init({dir, branch})`: `git init -b <branch> -- <dir>`, then `openRepo`.
- Failures: `auth`, `not-found` (repository not found), `exists`, `aborted` (then remove the
  partial folder, only if we created it).

**Security.**
- Clone of a hostile repo can't run code at clone time: no hooks, `--no-recurse-submodules`,
  `protocol.file.allow` left at the default `user` (fine for local paths the user typed), and
  `protocol.ext.allow=never` from `GLOBAL_ARGS`.
- Opening it afterwards goes through the trust check (`src/repo-trust.js` `confirm`, which runs
  `git.riskyLocalConfig` and `git.riskyHooks` for every repo). A fresh clone has no local config
  beyond `remote.origin` and only git's `*.sample` hooks, so it opens without a prompt.

**Testing.**
- Clone from a local bare repo (existing test fixtures): progress, cancel mid-way (partial folder
  removed), an existing target, a bad URL.
- Init.
- The auto-fetch scheduler as a pure unit with fake timers: focus, busy, and auth-failure backoff.

**Acceptance criteria.**
- Clone a public GitHub repo over HTTPS from the welcome screen, and it opens with its graph.
- Cancel at 30 %: no folder is left.

**Size:** M (~1.1k LOC).

**Risks.**
- Clone progress parsing across git versions.
- Very large clones (long-running, no timeout).
- Windows long paths (`core.longpaths`).

### 3.7 P4: Commit search, file history, blame

**Scope.**
- (a) Search commits by message, author or sha. Content search (`-S`) is opt-in.
- (b) The history of one file, following renames.
- (c) Blame of a file at a commit or at the working copy.
- These share a **centre file view**, a new centre mode beside the diff view and R3's editor.

**UX.**
- **Search**: ⌘F (a new `KEYS` entry `search`, `inField: false`) opens a search box in the graph
  header. Enter or ⌘G / ⇧⌘G go to the next or previous match, with a "3 of 41" counter.
  - Matches are highlighted and other rows dimmed.
  - Results beyond the loaded rows load more history, as the sidebar selection already does (up
    to `LOG_MAX`).
  - Esc clears.
- **File history**:
  - Opened from the "File history" item in the file row context menu (WIP and commit file lists)
    and a History button in the diff header.
  - The centre shows a commit list (sha, subject, author, date, rename markers) on the left and
    that commit's diff of the file on the right, reusing `diff-view`.
  - "View in graph" selects the commit.
- **Blame**:
  - Opened from a Blame toggle in the same file view, and "Blame" in the file menus.
  - A gutter shows sha7, author and relative date per line group. Clicking a group selects the
    commit, and hovering shows the summary.
- Flows: `PLFlows.search(store)` is UI only, and the rest is store actions (`openFileHistory`,
  `openBlame`). These are reads, so they never queue.

**Backend ops** (reads):

```js
searchCommits({text, fields: ['message','author','sha'], content = false, limit = 1000}) -> {shas: [sha], truncated}
fileHistory(path, {limit = 500, skip = 0, follow = true, rev?}) -> {entries: [{sha, subject, author, date, status, path, oldPath?}], hasMore}
blame(path, {rev?: sha}) -> {rev, groups: [{sha, start, count, author, date, summary, boundary}], truncated}
```

**Git commands.**
- Search:
  - `rev-list --date-order --max-count=N --regexp-ignore-case --fixed-strings --grep=<t>` over the
    same tips as `log`.
  - Author uses `--author=<t>`.
  - Sha uses `rev-parse --verify --quiet <t>^{commit}` when `/^[0-9a-f]{4,40}$/`.
  - Content, opt-in: `-S<t>`.
  - The `-z`-free output is plain shas. Text goes into its own argv element after an `=`, so it is
    never parsed as an option.
- File history: `log --follow --name-status -z --format=%x00%H%x00… -- <path>` (paged with
  `--skip`).
- Blame: `blame --porcelain [<sha>] -- <path>`, capped like the diff caps (20k lines, 50 MB). A
  binary file gives kind `binary`.
- Working-copy blame: `blame --porcelain --contents - -- <path>` with the file on stdin, or no rev
  at all.

**Security.**
- `relPath` for paths, and sha validation.
- The search text length is capped at 200 characters, with no `\0`.
- Output goes into textContent only.

**Performance.**
- Search over 10k commits is fine (a single rev-list).
- Blame on big files runs off the write queue.
- Cancel the previous search or blame when a new one starts (opIds).

**Testing.**
- `git.test.js`:
  - search with regex characters taken literally
  - author and sha prefixes
  - history across a rename
  - blame of a commit and of the working copy
  - caps and binary files
- `store.test.js`: search navigation that loads more.
- `diff-view` and file-view harness tests.
- Smoke run: search on the 20k repo in under 300 ms.

**Acceptance criteria.**
- ⌘F "watcher" finds the commits with it in the message and jumps between them.
- File history of `src/git.js` lists every commit that touched it, including before a rename.
- Blame of `main.js` matches `git blame --porcelain` line for line.

**Size:** L (~2.5k LOC).

**Risks.**
- The file view is a third centre mode: design one small "centre router" in the store (diff /
  file view / R3 editor) so the modes don't fight.
- `--follow` limitations (one path, heuristics).

### 3.8 P5: Conflict resolution beyond Keep-a-side

**P5a: External merge tool (S).**
- A "Open in merge tool" button on a conflicted file row, enabled when `merge.tool` is configured.
- Runs `git mergetool --no-prompt [--tool=<t>] -- <path>`, cancellable, with no timeout.
- **Done:** `mergetool.*.cmd` / `mergetool.*.path`, and `difftool.*.cmd` / `difftool.*.path`, in
  **local** config are risky keys (`RISKY_CONFIG`, `src/git.js` `riskyLocalConfig`). The global
  config is the user's own.
- The file is marked resolved when the tool exits 0 and `mergetool.<t>.trustExitCode` allows it.
  Otherwise ask.
- Size S (~400 LOC).

**P5b: The in-app 3-way editor (XL).**
- Read op `conflictVersions(path) -> {base?, ours, theirs, merged, labels, binary, truncated}`,
  using `cat-file blob :1:<p> / :2: / :3:` as bytes, plus
  `git merge-file -p --diff3 --object-id :1:p :2:p :3:p`. The `--object-id` form is present
  in git 2.51.2 (checked with `merge-file -h`). This gives a marker-annotated merge with no temp files.
- It is parsed into chunks by a pure `renderer/conflict-model.js`.
- UI:
  - Two panes (ours / theirs, named by branch like R2) and an editable output pane.
  - Per chunk: take ours, theirs, both (either order) or none.
  - "Take all", "conflict 2 of 5", n / p.
  - The output is editable as plain text (a textarea-backed virtual list: no Monaco, keep the
    no-framework rule).
- Write op: `saveResolution(path, content, {fingerprint})`. It writes the bytes with the hunks.js
  safety rules (symlink refusal, `stale` check) and stages them (Mark resolved). It is undoable
  through `withDiscardBackup`.
- Handles modify/delete conflicts, binary files (Keep a side only) and CRLF.
- Tests: the chunk model as property tests against `git merge-file` output; the byte-exact save;
  the harness UI.
- Size XL (~3.5k LOC).
- Risk: an editor component without a framework is the largest UI piece in the app. Prototype it
  first.

### 3.9 P6: Windows, settings, theme

**One repo per window (M).** *Superseded:* several repos were built as tabs instead (one
`WebContentsView` and one `src/tab-session.js` session per tab, restored from `tabs.json`;
`main/tabs-controller.js`). The window plan below is kept for reference only.
- `main.js` keeps `current`, the watcher session and the trust prompts in a
  `Map<webContentsId, {root, watch}>`. The IPC `op` handler already injects the root from main's
  state; it becomes the sender window's root.
- `ops` runners are already per repo (write queue by root).
- The quit guard lists the ops of every window.
- File > "New Window" (⇧⌘N), and "Open in New Window" from Recent.
- The same repo open twice focuses the existing window.
- Restoring windows on launch uses `userData/session.json`.
- Tabs (L) were built instead, with one webContents per tab.

**Settings (M).**
- `userData/settings.json`, owned by main and validated by a schema in `src/settings.js`.
- `app:getSettings` / `app:setSettings`.
- A Preferences modal (⌘,) with these sections:
  - General: auto-fetch interval, default pull mode, restore windows
  - Git: identity (`git config [--global] user.name/email` through ops `setIdentity`, validated),
    commit template, skip hooks
  - Appearance: theme Dark / Light / System (`nativeTheme` + a second token set in `style.css`),
    date format
  - Tools: terminal app, external editor, merge tool (display only; tool config stays in git)
  - Graph: shown columns, commits to load
- Per-repo overrides are **Later**.

**Hide and solo branches (M, P6 stretch).** A per-repo hidden-refs set feeds `log`'s tips
(`currentTips` minus the hidden refs). Sidebar eye toggles, and "Solo" menu items.

**Size of P6 in total:** L (~2.5k LOC), split into three independent pieces.

### 3.10 P7 (conditional): Hosting integrations

- **Step 1, S:** "Push and open a pull request": after a push, open
  `https://<host>/<owner>/<repo>/compare/<branch>?expand=1` (GitHub), or the GitLab / Bitbucket /
  Azure equivalents, in the system browser through `shell.openExternal`. Checks:
  - host from the remote URL
  - only `https`
  - an allow-list of URL shapes
  - no credentials
- **Step 2, XL:** OAuth device flow per host, with tokens stored in the OS keychain
  (`safeStorage`). Then a PR list in the sidebar, PR checkout, and a create-PR form. Build this
  only after Q1 is answered.

---

## 4. Phased roadmap

**Order and dependencies:**

```
R1 → R2 ─┬─► P1 (commit surgery) ───────────┐
         │    needs R1 banner, R2 menus       │
         ├─► P2 (refs & remotes) ────────────┤  P1 ∥ P2 ∥ R3/R4
         │                                    │
R3 → R4 → R5 (undo records) ─► P1 undo parts  │
                                              ▼
                 P2 URL validator ─► P3 (auth, clone, init, auto-fetch)
                                              │
                         P4 (search, history, blame)   (independent; can start after R3's centre view)
                                              │
                         P5a (external tool) ─► P5b (3-way editor)
                                              │
                         P6 (windows, settings, theme) ─► submodules / worktrees "open in window"
                                              │
                         P7 (integrations, conditional)

Production track (parallel from now): X1 CI → X2 packaging/signing → X3 auto-update; X4 with P3; X5–X8 before 1.0
```

| Phase | Contents | Shared plumbing it adds | Size | Can run in parallel with |
|---|---|---|---|---|
| **P1** Commit surgery | Cherry-pick, revert, reset (3 modes), restore file from commit, undo for all of them | `src/sequencer.js`; a generic record-commit helper (lifted from R5) used by reset, cherry-pick and revert; the banner sequencer variant | M+M (~2.4k) | P2, R3/R4. The undo pieces need R5's record handler, so land P1 undo right after R5, or build the helper in P1 and let R5 reuse it |
| **P2** Refs and remotes | Tags (create, annotated, delete + undo, push, remote delete), rename branch, delete remote branch, push to…, fast-forward, remote CRUD, stash selected files, copy name | `src/urls.js` validator, `dialog.form` and multi-line prompt contracts, `delete_tag` undo action | S–M + M (~2.1k) | P1 (P1 is in the graph menus and sequencer, P2 in the sidebar and ref ops; they touch `actions.js`/`START_FLOWS` lightly) |
| **P3** Network and onboarding | Credential prompts, clone, init, auto-fetch | The helper runner and socket bridge (shared with the R1 editor helper), app-level progress events | L + M (~2.9k) | P4 |
| **P4** History exploration | Search, file history, blame; whitespace-ignore diff (stretch) | The centre router, the file view | L (~2.5k) | P3, P5a |
| **P5** Conflicts | P5a external merge tool; P5b 3-way editor | `conflict-model.js`, the editable text view | S + XL (~3.9k) | P6 (after P5a) |
| **P6** Workspace | Several windows + restore, settings UI, identity, light / system theme, graph columns, hide / solo | `src/settings.js`, main's per-window state | L (~2.5k) | P5b |
| **P7** Integrations | PR link in the browser, then OAuth + PR list (conditional) | keychain token store | S, then XL | anything |
| **Later bucket** | Command palette, submodule / worktree UI, LFS awareness, signature display, patches, co-author helper, shortcut sheet, notifications, split diff, compare with working dir, remove-remote undo, raising the log cap | – | – | – |

**Suggested order for one developer:** P1 → P2 → X2 (first signed build) → P3 → P4 → P6 → P5 →
P7. P6 moves before P5b because windows and settings unblock several Later items and are cheaper;
P5a can be dropped in at any point.

**With two developers:** A takes P1 then P3; B takes P2 then P4. X1 and X2 are split between them
early.

---

## 5. Non-feature gaps (production readiness)

| # | Item | What | Where it fits | Size |
|---|---|---|---|---|
| X1 | **CI on macOS, Windows, Linux** | *Partly done:* `.github/workflows/test.yml` runs `npm test` on macOS and Ubuntu; Windows, the smoke run and the Electron cache are still to do. GitHub Actions matrix. Install git ≥ 2.51 on every runner (Ubuntu: the git-core PPA; Windows: Git for Windows 2.51+; macOS: Homebrew). Run `npm test` (about 3 min now, more after R1–R5), plus a smoke run under `xvfb-run` on Linux and headless on macOS. Cache Electron. Record test time per suite | **Now**, before more features: Windows path rules (`relPath`, `findOnPath`) and the Linux watcher are untested on real OSes | S–M |
| X2 | **Packaging and signing** | electron-builder or Forge. macOS: arm64 + x64 (or universal) dmg, hardened runtime, Developer ID, notarization (`notarytool`). Windows: NSIS or MSIX, Authenticode (Azure Trusted Signing or an EV cert). Linux: AppImage + .deb. Electron fuses (asar integrity, no `--inspect`). **But** the `RunAsNode` fuse must stay on, or the editor and askpass helpers need their own binary (rebase.md, §3.5). The `--smoke` mode is already disabled when packaged | Right after P2 | M |
| X3 | **Auto-update** | `electron-updater` with GitHub Releases, or update.electronjs.org (public repos). Signed feeds, "Check for Updates…" in the app menu, "Restart to update". Never restart while a git op runs: reuse the quit guard | After X2 | M |
| X4 | **Real network auth testing** | The manual matrix in §3.5, written up as a flow table (steps, expected, observed, result), like the milestone 7 run | With P3 | S |
| X5 | **Windows and Linux verification runs** | Repeat the M7 flow table on Windows 11 and Ubuntu (watcher latencies, terminal launch, CRLF, long paths) | After X1; again before 1.0 | S each |
| X6 | **Pruning our refs** | `refs/pasta-lite/backups/*`, `rebases/*`, `records/*`: keep the last N or 30 days, and prune when a repo opens (idle). They must never be pruned while undo still points at them | Before 1.0 | S |
| X7 | **Crash upload** | Stays local (`crashReporter` runs with `uploadToServer: false`). An opt-in uploader only if you want one (Q9) | Only on request | S–M |
| X8 | **Accessibility audit** | VoiceOver / NVDA pass over the graph grid, dialogs, the banner, the R3 editor and the file view; contrast check for the light theme | With P6 | S–M |
| X9 | **Bundled git or not** | Today: system git ≥ 2.51, refused otherwise. Packaged users on stock macOS (Apple git 2.50) are refused. Either bundle a git, or show a first-run "Install git" page with instructions | Decide before X2 (Q5) | M if bundled |
| X10 | **Performance headroom** | Keep the 10k log cap until search lands. Then measure 100k-commit and 5k-ref repos (graph paging, `refs`, the sidebar), and a status with 50k untracked files | After P4 | S (measure), M (fix) |

---

## 6. Open questions for you

1. **Hosting integrations:** which hosts matter (GitHub only, or GitLab / Bitbucket / Azure,
   self-hosted)? Is "open the PR page in the browser" (P7 step 1) enough for now, or do you want
   an in-app PR list with OAuth?
2. **Solo or team use:** is the main user one person or a team? Team use raises auto-fetch,
   remote branch cleanup and PRs; solo use raises reset, cherry-pick and search.
3. **Platforms:** is Windows and/or Linux a real target for 1.0? That decides whether X1 / X5 run
   on all three OSes and whether the askpass helper needs Windows named pipes now.
4. **Distribution:** do you have an Apple Developer ID and a Windows signing option (Azure Trusted
   Signing or EV)? Should updates come from GitHub Releases, and is the repo public or private?
5. **Git dependency:** bundle a git (bigger app, but it works on stock macOS) or keep requiring
   git ≥ 2.51 with an install guide?
6. **Auto-fetch default:** off, or every few minutes? It must never prompt from a
   timer.
7. **Several repos:** is one repo per window enough, or do you want tabs in one window
   (about 2× the work)? *Answered: tabs, now built.*
8. **Conflict editor:** after R2's Keep ours / theirs, is an external merge tool enough for a
   while, or is the 3-way editor a priority over search, history and blame?
9. **Crash reports:** stay local only, or add an opt-in upload (and to where)?
10. **Undo scope:** should tag creation, branch rename and remote add / remove be undoable too
    (more reflog record kinds), or only destructive actions (reset, tag delete, remote-branch
    delete can't be undone because it is on the server)?
11. **Reset from a terminal:** entries made by git's own `reset: moving to …` are not undoable by
    design (they can't be known to be safe). OK?
12. **Won't-do list:** do you agree with dropping Gitflow, the built-in terminal, profiles,
    workspaces and dashboards, AI features and i18n?
