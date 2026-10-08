# Pasta Lite: rebase (and merge) plan

Post-v1 plan for rebase in the GUI: rebase from menus, drag-and-drop Merge/Rebase, interactive
rebase, the rebase-in-progress state (banner, conflicts, Continue / Skip / Abort), autostash,
force-push follow-up and undo. It also covers a small **merge** feature (§8): a user has asked
for "merge branch into current", and merge uses the same popup, conflict state and
continue/abort plumbing.

Status: **R1–R3 are built** (`src/rebase.js`, `src/rebase-state.js`, `src/rebase-editor.js`, `src/merge.js`, `src/ops-rebase.js`, `renderer/flows-rebase.js`, `renderer/components/rebase-editor.js`, `renderer/components/op-banner.js`); **R4 and R5 are not**. The text below is the plan as written; where the build differs, the code wins. It builds on the app's git
conventions (`src/git-process.js`), undo (`src/undo.js`), the flow, menu and dialog contracts (`renderer/flows-kit.js`, `renderer/menus.js`, `renderer/dialog.js`), the watcher (`src/watcher.js`) and logging (`src/log.js`). Each feature below is specified by the behaviour a user sees and
decided on its own merits: git's semantics, safety, and the work it saves.

Every git fact marked **(verified)** was checked with git 2.51.2 in throwaway scratch
repositories (not this repo). The rest follows git's documentation and must be confirmed by
the R1 tests.

---

## 1. Summary

| Milestone | Scope | Size |
|---|---|---|
| **R1** | Backend foundation: in-progress state detection (rebase + merge), `rebaseContinue` / `rebaseSkip` / `rebaseAbort`, the editor helper, persistent autostash, the operation banner, WIP-panel conflict mode, toolbar gating. It also fixes today's gap where a conflicted Pull (rebase) says "continue the rebase from a terminal" | ~2.4k LOC (half tests) |
| **R2** | **Merge first** (merge into current, Commit and Merge, Abort), then non-interactive "Rebase X onto Y" from the sidebar, graph rows and ref pills; the published-commits warning; the force-push-with-lease follow-up; "Take mine / Take theirs" on conflicted files | ~2.2k LOC |
| **R3** | Interactive rebase: `rebasePlan` + `rebaseInteractive` ops with an allow-listed todo, the editor view in the centre (pick / reword / squash / fixup / drop / edit, reorder by mouse and keyboard), reword/squash message dialog, `edit` stops | ~3k LOC |
| **R4** | Drag-and-drop: branch onto branch (graph pills and sidebar rows) opens a Merge / Rebase / Interactive Rebase popup; Alt-drop goes straight to interactive | ~1.2k LOC |
| **R5** | Undo/redo of rebase and merge (our own reflog record), progress events ("Rebasing commit 3 of 7"), graph shortcuts (Reword… / Drop… / Squash into parent), opt-in `--update-refs`, polish and the verification run | ~1.8k LOC |

Key decisions:

1. **Never ask git to open a real editor.** An interactive rebase is driven by `GIT_SEQUENCE_EDITOR`
   and `GIT_EDITOR` set to a **constant** shell command (`src/rebase-editor.js`, roles todo|msg).
   git runs it through its shell, and the one path it needs (the git dir) reaches it **only
   through an environment variable**, so nothing from the renderer or the repo is ever put into
   a command string (§3.3). The editor copies a todo file (or a message file) that the **backend**
   wrote.
2. **The backend writes the todo, never the renderer.** The renderer sends
   `[{action, sha}]`. `ops.js` checks the list against the range it computes itself: an allow-list
   of commands (`pick reword edit squash fixup drop`, plus `update-ref` only for refs we listed),
   full shas, each commit in the range exactly once, and nothing else. **`exec`, `break`, `label`,
   `reset` and `merge` are never accepted.** git also runs with `rebase.missingCommitsCheck=error`
   as a second guard.
3. **A stop is a result, not an error.** The rebase ops resolve `{status: 'done' | 'stopped' | 'up-to-date', …}`.
   Conflicts and `edit` stops leave the repo in a state the banner and the WIP panel show. Errors
   are kept for refusals and failures (hooks, dirty tree, a changed plan).
4. **Our own autostash, kept alive across stops.** Uncommitted changes are stashed with the
   existing index-preserving `withAutostash` logic, and the stash is recorded in
   `refs/pasta-lite/autostash`. When the rebase finishes, is skipped to the end or is aborted
   (from the app, or later noticed after a terminal did it), the stash is re-applied with
   `--index`. git's own `--autostash` was rejected because it loses the staged/unstaged split and
   ignores untracked files (verified, §3.8).
5. **Checking a branch out comes first.** Rebasing a branch that isn't checked out first asks to
   check it out, so the rebase runs in the worktree, where hooks, signing and conflict stops work.
   `git replay` (experimental in git, no worktree needed) is deferred.
6. **Merge is built first, in R2.** It is smaller, a user asked for it, and it exercises the whole
   conflict / banner / continue / abort loop with one stop. The drag-drop popup needs both.
7. **Undo comes from a custom reflog record** that our ops write when a rebase or merge finishes
   (`rebase: [<record>] <branch>`, the same pattern as discard backups). git's own
   `rebase (finish)` entries are recognised too. Undo needs a clean worktree and the branch still
   at the result. It is done with a two-tree `read-tree -m -u` plus `update-ref -m "undo: …"`.
8. **The conflict editor stays out of scope.** R2 adds per-file "Keep <onto>" / "Keep <commit>"
   (`checkout --ours/--theirs`, with the rebase's ours/theirs swap handled) and Mark resolved. A
   3-way editor is its own project (§13).

---

## 2. Feature inventory

Features are described by behaviour. Milestones: R1–R5. **Defer** = not in this plan.

| # | Feature (behaviour) | Decision | Reason |
|---|---|---|---|
| F1 | Branch / ref context menu: rebase or interactively rebase the current branch onto it; commit menu: rebase the current branch onto this commit | **Keep, R2** (interactive R3) | The core feature. The menus already exist (`sidebar.js` `branchMenuItems`, `graph-view.js` `commitMenuItems`) |
| F2 | Commit in HEAD's history: interactively rebase the commits above it | **Keep, R3** | The usual way to edit your last N commits |
| F3 | Drag a branch onto another → a popup to merge, rebase, interactively rebase or fast-forward | **Keep, R4** | High value: the most direct way to put one branch on another. It depends on R2/R3 flows, so it is a thin UI layer on top |
| F4 | Alt/Option while dropping → interactive rebase directly | **Keep, R4** | The task lists it. R4 treats Alt-drop as "open the interactive editor" and the popup still offers everything |
| F5 | Interactive rebase view: pick / reword / squash / drop per commit, drag to reorder, one-key shortcuts, reset / cancel / start buttons, and a header with the commit count and target | **Keep, R3** | The core interactive-rebase actions. Also: `fixup` (Squash without its message) and `edit` (stop to amend). They are cheap once stops are handled, and `edit` stops come from terminals anyway |
| F6 | Not available with merge commits in the range, or with the root commit | **Keep the restriction** | `--rebase-merges` and `--root` are deferred. The ops refuse with kinds `merge-commits` / `root-commit` |
| F7 | In-progress state: a conflicts panel, a header naming the branch and target, continue / skip / abort buttons, and a progress overlay | **Keep, R1** (progress overlay R5) | Needed by everything, including today's Pull (rebase), which can already stop with conflicts |
| F8 | A rebase started outside the app (including an *interactive* one) is flagged | **Keep, R1** | We show the same banner and offer Continue / Skip / Abort. These are git-level commands, safe whoever started the rebase. We only refuse to *edit* its todo |
| F9 | Conflict resolution: conflicted and resolved file lists, mark resolved (per file or all), a built-in merge tool, an external merge tool, take one side per file | **Partly.** Lists and Mark resolved exist (M4). **R2** adds Keep-ours/theirs per file (named by branch/commit) and "Mark all resolved". Merge tool and external tool: **Defer** | A conflict editor is a separate, large component (§13). Keep-a-side covers the common "take one side" case |
| F10 | Autostash: uncommitted changes are stashed before the rebase and popped after it, with a stash message naming the branch | **Keep, R1** | Our own autostash, persistent across stops (decision 4) |
| F11 | Rebasing a branch that isn't checked out: asks to check it out first (and to stash changes first when dirty) | **Keep, R2** | Hooks, signing and conflict stops need a worktree. `git replay` without a checkout is deferred: it is experimental, skips hooks and signing, and can't stop for conflicts |
| F12 | Rebasing pushed commits, then the push is rejected → force push with lease, or a plain force push | **Keep, R2** | We warn *before* ("n commits are already on origin/x") and offer Force Push (lease) *after*, using the existing `forcePush` flow. We never offer a plain force push (no lease): the M5 design refuses it |
| F13 | Pull (rebase) | **Exists** (`git.pull` mode `rebase`). **R1** hooks it into the banner and the autostash marker, and replaces "continue from a terminal" | |
| F14 | Undo of a rebase (needs a clean worktree first) | **Keep, R5** | Our reflog-driven undo (`src/undo.js`) extended with a `rebase` action (§6 here) |
| F15 | Protected / upstream warnings | **Keep a light version, R2** | Warn when the rewritten commits are on any remote-tracking branch, or when the branch is the upstream's default branch. A configurable protected-branch list is deferred (open question Q3) |
| F16 | `--update-refs` / stacked branches | **Defer to R5, opt-in** | It moves branches other than the one being rebased, so it must be an explicit choice. Until R5 every rebase passes `--no-update-refs` explicitly (as pull does), so `rebase.updateRefs=true` in a user's config can't move other branches silently |
| F17 | Graph shortcuts: reword, edit the message, drop or squash commits from the graph, with a note on how many commits a reword rebases | **Keep, R5** (single commit; multi-select needs a multi-select graph: **Defer**) | Thin wrappers that build a one-line-changed todo for `rebaseInteractive` |
| F18 | Signing and hooks: `commit.gpgSign` and hooks are respected; a skip-hooks option | **Keep respecting config** (R1). "Skip hooks" for rebases: **Defer** | Hooks and signing run inside `git rebase`. We classify their failures (§3.9) |
| F19 | AI commit restructuring, interactive cherry-pick | **Never / Defer** | Out of scope |

---

## 3. Git mechanics

### 3.1 Global invocation for every rebase command

On top of what every git command gets (`GLOBAL_ARGS`, `LC_ALL=C`, `GIT_TERMINAL_PROMPT=0` and the env allowlist of `src/git-process.js`), every
rebase command gets these explicit `-c` overrides, so user config can't change what we parse or
what git does:

```
-c rebase.missingCommitsCheck=error     # our todo must list every commit (defence against our own bugs)
-c rebase.abbreviateCommands=false      # the todo and done files use full command words
-c rebase.instructionFormat=            # todo/done lines stay "cmd <sha> # <subject>"
-c rebase.rescheduleFailedExec=false
-c rebase.forkPoint=false
-c commit.cleanup=strip -c core.commentChar=#   # see §3.6
-c advice.mergeConflict=false -c advice.skippedCherryPicks=false
```

Flags on every start command: `--merge` (never the apply backend), `--no-autostash`,
`--no-autosquash`, `--no-rebase-merges`, `--no-fork-point`, `--no-update-refs` (until R5's
opt-in), `--empty=drop`. The target is always a **full object id** (resolved in validation by
`ops.js` `commitId`), so no ref name reaches git's argument parsing.

Env: `GIT_EDITOR=true` is already in `exec.js` `baseEnv`. **R1 adds `GIT_SEQUENCE_EDITOR=true`** to
`baseEnv` for defence in depth: a plain `git rebase` never opens a sequence editor, but a
`sequence.editor` from a hostile config then can't run through any other path. The env variable
takes precedence over `sequence.editor` / `core.editor` config.

Timeouts: none (a rebase can legitimately take minutes). Cancellation: §4.4.

### 3.2 Non-interactive rebase ("Rebase X onto Y")

```
git <overrides> rebase --merge --no-autostash --no-autosquash --no-rebase-merges --no-fork-point \
    --no-update-refs --empty=drop <onto-sha>
```

- Runs on the checked-out branch (or detached HEAD) and rewrites `merge-base(HEAD, onto)..HEAD`
  onto `onto`.
- Commits whose patch is already upstream are skipped silently (git's default
  `--no-reapply-cherry-picks`). The op reports how many were skipped: the difference between
  `rev-list --count --cherry-pick --right-only onto...HEAD` before and the commits replayed.
- Up to date (`onto` is already an ancestor of HEAD and HEAD isn't behind): git prints "Current
  branch x is up to date" and exits 0. The op checks this first (`merge-base --is-ancestor`) and
  resolves `{status: 'up-to-date'}` without running rebase (and without running `pre-rebase`).
- A fast-forward (HEAD is an ancestor of `onto`): rebase moves the branch (reflog
  `rebase (finish)`). That is allowed and reported as `fastForward: true`.
- HEAD reflog of a finished rebase **(verified)**: `rebase (start): checkout <onto>`,
  `rebase (pick): <subject>` per commit (or `rebase: fast-forward` for unchanged picks),
  `rebase (finish): returning to refs/heads/<b>`. That last entry is a **no-op** (old == new) in
  the HEAD log. The branch's own log gets `rebase (finish): refs/heads/<b> onto <onto-sha>` with
  old = the pre-rebase tip. `ORIG_HEAD` = pre-rebase tip.

### 3.3 Interactive rebase, driven non-interactively

Start:

```
env  PL_GIT_DIR=<absolute git dir>
     GIT_SEQUENCE_EDITOR='<the editor function> pl_edit todo'   (rebase-editor.TODO_EDITOR)
     GIT_EDITOR='<the editor function> pl_edit msg'             (rebase-editor.MSG_EDITOR)
git <overrides> rebase -i --no-autostash --no-autosquash --no-rebase-merges --no-fork-point \
    --no-update-refs --empty=drop [--onto <onto-sha>] <upstream-sha>
```

**Why this is safe.** git runs an editor value through `sh -c '<value> "$@"' <value> <file>`.
Our values are **constant strings**. The only data are the environment variables, which `sh`
expands inside double quotes as single words, so paths with spaces, quotes or `$` can't break out.
Nothing from the renderer, a branch name or a commit message is ever part of an argv element
except full shas, and those only inside the todo file. The editor is a POSIX `sh` function (sh,
cat, grep and awk only), so it runs wherever git runs an editor, Git for Windows' `sh` included,
and nothing of the app's runs: an earlier Node helper ran under `ELECTRON_RUN_AS_NODE`, which the
packaged app's runAsNode fuse now turns off.

`src/rebase-editor.js` (the constant commands, and `validTodo`, which the backend checks before
it writes the todo):

- `todo <file>`: refuses (exit 1) unless `<file>` is the very file
  `$PL_GIT_DIR/rebase-merge/git-rebase-todo` (`-ef`; neither it nor `rebase-merge/` a symlink).
  Checks every line of `<git-dir>/pasta-lite/rebase/todo` against the allow-list again and copies
  it over the todo. If the editor exits
  non-zero, git doesn't start the rebase and leaves no `rebase-merge/` behind **(verified with a
  failing editor)**.
- `msg <file>`: refuses unless `<file>` is `$PL_GIT_DIR/COMMIT_EDITMSG` (not a symlink). Reads
  the **last line of `<git-dir>/rebase-merge/done`**, which is the
  command git is completing, with its full sha **(verified: at a reword the last done line is
  `reword <sha>`, and for a squash group it is the group's last `squash`/`fixup` line)**. If
  `<git-dir>/pasta-lite/rebase/msgs/<sha>` exists (a plain file), the editor writes it to
  `<file>`. Otherwise it leaves git's text alone (git then strips the comment lines, §3.6).
- The state folder and every prepared file must be plain (no symlink), and it writes only the
  one file git named.

The todo file is written by `ops.js`/`src/rebase.js` **only** from validated `{cmd, sha}` pairs,
oldest first, one `cmd <full-sha>\n` per line, with no subject comments (so no untrusted text).
`update-ref refs/heads/<b>\n` lines appear only in R5's opt-in mode, only for local branches the
plan listed, and only after `validateBranchName`.

Allow-list and validation: §4.3. A todo git rejects (for example a sha git can't find) **leaves a
rebase in progress with "No commands done"** **(verified)**. So `rebaseInteractive` validates
first and, if git still rejects the todo, runs `rebase --abort` itself before rethrowing (kind
`invalid-todo`).

Messages (reword, and the final message of a squash group) are written to
`<git-dir>/pasta-lite/rebase/msgs/<sha>` (0600) before the rebase starts. They are keyed by the
sha the helper will see: the reworded commit's own sha, or the **last** member of a squash group.
They live under the git dir (not `os.tmpdir()`) because a later `rebaseContinue` may need them
after a stop. The folder is removed when the rebase finishes or is aborted. The watcher ignores
`.git/pasta-lite/**` (unknown git-internal paths are already `null` in `watcher.js` `classify`).

### 3.4 Detecting an in-progress rebase

`exec.repoState` already returns `rebasing` for `rebase-merge/` or `rebase-apply/` (and `am` for
`rebase-apply/applying`). R1 adds `src/rebase.js` `rebaseState(cwd) → null | RebaseState`,
included in `git.status` as `status.rebase` (null unless `state === 'rebasing'`), so the store's
normal status read carries it and the watcher's `rebase-*/ → full` rule already refreshes it:

```js
RebaseState = {
  backend: 'merge' | 'apply',
  interactive: boolean,          // rebase-merge/interactive exists (true for plain merge-backend rebases too; verified)
  ours: boolean,                 // our meta.json exists and its origHead === rebase-merge/orig-head
  branch: 'feat' | null,         // head-name 'refs/heads/feat' (null: 'detached HEAD'); status.branch is null mid-rebase (verified)
  onto: sha, origHead: sha,
  ontoName: string | null,       // from meta.json (validated ref name) — else the renderer names onto via refsBySha
  step: { done: 3, total: 7 },   // commit commands in done vs done + todo (see below)
  current: { cmd: 'pick', sha, subject } | null,   // last line of `done`
  stop: 'conflict' | 'edit' | 'empty' | 'hook' | 'other',
  stopMessage: string | null,    // rebase-merge/message minus comment lines, for the composer at a conflict stop
  conflicted: number,            // status.conflicted.length (duplicated for the banner)
  todoEditable: boolean,         // ours && no exec/break/label/merge lines remain
  autostash: sha | null,         // refs/pasta-lite/autostash
}
```

Files read (each capped at 1 MB, lines at 10k, shas checked against `git.OID`, anything malformed
→ `stop: 'other'` rather than a throw):

| File (merge backend `rebase-merge/`) | Meaning (verified) |
|---|---|
| `head-name` | `refs/heads/<b>` or `detached HEAD` |
| `onto`, `orig-head` | full shas |
| `done` | commands already run; the last is the current one (`pick <sha> # subject`) |
| `git-rebase-todo` | commands left (skip `#` and blank lines) |
| `msgnum` / `end` | step counters. **`end` counts every command, `update-ref` included**, so the banner counts commit commands (`pick reword edit squash fixup merge`) from `done` + `git-rebase-todo` and uses `msgnum/end` only as a fallback |
| `stopped-sha` | the commit being replayed at the stop |
| `amend` | present **only at an `edit` stop** (verified). With `REBASE_HEAD` it tells `edit` apart from a conflict |
| `message`, `author-script` | the stopped commit's message / author (the message is what continue commits, verified) |
| `update-refs` | refs `--update-refs` will move (R5) |
| `autostash` | git's own autostash (we never create it; if present, an external `--autostash` rebase is noted in the banner) |
| `$GIT_DIR/REBASE_HEAD` | the commit being replayed (conflict and edit stops) |

The apply backend (`rebase-apply/`: `next`, `last`, `head-name`, `onto`, `orig-head`) is read for
display only. It gets `interactive: false` and `todoEditable: false`, and Continue / Skip / Abort
work the same.

Stop classification: `conflicted > 0` → `conflict`; `amend` present → `edit`; `REBASE_HEAD` and a
clean index → `empty` (a pick that became empty with `--empty=stop`, from an external rebase);
our last op failed with `hook-failed` → `hook`; otherwise `other`.

### 3.5 Continue / Skip / Abort semantics

| Command | Exact argv | Semantics (and what the UI must say) |
|---|---|---|
| Continue | `git <overrides> rebase --continue` with the helper `GIT_EDITOR` env (§3.3) | Refuses with unmerged paths: "needs merge / You must edit all merge conflicts…" **(verified)** → the op checks first (kind `conflicts`, with `count`). With **unstaged** changes git refuses ("You have unstaged changes") → the op checks first (kind `dirty`). At a **conflict stop** git commits the index with `rebase-merge/message` **and the original author** **(verified: Alice kept)**, and it **opens the editor for that message** **(verified)**, so an edited message passes through `msgs/<stopped-sha>`. If the resolution leaves nothing to commit, git **drops that commit silently** and moves on **(verified)**; the op reports it (`dropped: [sha]`). At an **edit stop**, staged changes are **amended into the stopped commit** (the `amend` file), so the UI says so |
| Skip | `git <overrides> rebase --skip` | Throws away the current commit's changes (and any edits to its conflicted files) and continues with the next. Untracked files stay. **Danger confirm.** |
| Abort | `git <overrides> rebase --abort` | Restores the branch and HEAD to `orig-head` and the worktree to it. Then **our** autostash is re-applied (§3.8) and `.git/pasta-lite/rebase` is removed. Not cancellable (§4.4) |
| Quit | `rebase --quit` | **Not offered** (it leaves HEAD detached at the partial result, a confusing state). Defer |

Why not "commit then continue"? A `git commit` made by us during a conflict stop gets **the user
as author, not the original author** **(verified)**. So `ops.commit` / `commitAll` refuse at a
conflict stop (kind `rebasing`: "Use Continue Rebase to commit the resolved changes"). They are
allowed at an `edit` stop, where amending or adding commits is the point.

### 3.6 Empty commits and message cleanup

- `--empty=drop`: commits that *become* empty are dropped (the non-interactive default, made
  explicit so interactive runs don't stop). Commits that were empty *to start* are kept (git's
  default since 2.26). The result lists dropped shas (`rewritten-list` vs `done`), and the notice
  says "2 commits became empty and were dropped".
- Messages: git strips `#` lines from editor-edited messages only when the cleanup mode says so.
  Under a hostile `commit.cleanup=verbatim`, git's own `# Conflicts:` / `# This is a combination of
  2 commits` comments would be committed. So every rebase command runs with
  `-c commit.cleanup=strip -c core.commentChar=#`. Consequence: **a line starting with `#` in a
  reworded or squashed message is removed.** The message dialog warns about it inline ("Lines
  starting with # are removed in rebased messages"). The app's normal commit keeps `#` lines
  (`--cleanup=whitespace`, M4), so this is a deliberate difference (open question Q6).

### 3.7 Rebasing a branch that isn't checked out

R2: the flow asks "To rebase feature/x it must be checked out first. Check it out now?" (plus
"Your local changes will be stashed and re-applied" when dirty). Then it runs the existing
`checkout` op followed by `rebase`, as two queued writes. The checkout's own autostash re-applies
immediately, so the rebase then autostashes on its own. A branch checked out in another worktree
is refused by git ("is already used by worktree at …") → kind `checked-out-elsewhere`.

Deferred: `git replay --onto <onto> <base>..<branch>` prints `update refs/heads/<b> <new> <old>`
**(verified in 2.51, marked "EXPERIMENTAL")** and could be piped into `git update-ref --stdin`
atomically, without touching the worktree. It can't stop for conflicts (it exits 1 and writes
nothing), it doesn't run hooks, and it doesn't sign, so it would only be an optional "fast path
when there are no conflicts". Q5.

### 3.8 Autostash: ours vs `--autostash`

git's `--autostash` **(verified)**: it re-applies the changes as unstaged (a staged edit came back
as ` M`) and doesn't stash untracked files. It does survive stops and apply on abort, but it loses
the staged/unstaged split. Our `git.withAutostash` keeps it (`stash apply --index`) and includes
untracked files. **Decision:** keep ours, and make it persistent:

1. Before `rebase`, if dirty: `stash push --include-untracked -m "pasta-lite autostash before rebase of <branch> [<id>]"`. Then
   `update-ref refs/pasta-lite/autostash <stash-sha> ""` (create-only). `<id>` is a random id
   also written to the `autostash-intent` file (with the time) before the push: after a crash
   between the push and the ref, only the stash with that id (made after that time) is this
   worktree's orphan, never another worktree's (the stash list is shared).
2. When a rebase op ends with the rebase **finished or aborted**: re-apply by hash
   (`applyStashHash`, `--index`, fall back to a plain apply), drop by hash, and delete the ref.
   Re-apply conflicts → `reset --hard HEAD`, keep the stash, and set kind `stash-conflict` on the
   *result* (`{status: 'done', stash: {kept: true, sha}}`), exactly as `withAutostash` does today.
   Review fixes: nothing is applied onto changes to tracked files (reason `dirty`) or when one of
   the stash's untracked files (`<sha>^3`) is in the way (reason `untracked`); both keep the ref,
   as does an apply git gives up on without conflicts (reason `index`, e.g. an `index.lock`), so
   Restore can be tried again. Only `conflict` deletes the ref. After a failed apply, the
   untracked files it restored are removed again. Submodules never count as changes (`status
   --ignore-submodules=all`), and the undo is `reset --hard --no-recurse-submodules HEAD`, run
   only while no tracked file outside the stash's paths changed meanwhile.
3. When a rebase op ends **stopped**: the stash stays in the stash list (visible in the sidebar,
   message says why) and the ref stays.
4. The rebase was finished or aborted **outside the app** (state clean, ref present): the banner
   shows "Your changes from before the rebase are in a stash" with **Restore** (op
   `restoreAutostash`: the same re-apply, then delete the ref) and **Keep in Stash** (delete the ref
   only). If the stash is gone (dropped by hand), the ref is deleted silently on the next read.
5. `git.pull` mode `rebase` switches to the same mechanism, so a conflicted Pull (rebase) is
   completed in the app and its stash comes back at the end. Today `stashKept` + "pop it yourself"
   is the only path.

### 3.9 Hooks and signing

What runs during a rebase **(verified)**:

| Moment | Hooks |
|---|---|
| Start | `pre-rebase <upstream>` (exit ≠ 0 refuses the rebase before anything changes), `post-checkout` |
| Each pick | `prepare-commit-msg`, `post-commit` (no `pre-commit` / `commit-msg`) |
| Reword / edited squash message | `pre-commit`, `prepare-commit-msg`, `commit-msg`, `post-commit`, `post-rewrite amend` |
| Continue after a conflict | `prepare-commit-msg`, `post-commit` |
| End | `post-rewrite rebase` |

- `pre-rebase` refusal → kind `hook-failed` with the hook output (`git.hookOutput`, 4k tail).
  Classified when git exits non-zero, `rebase-merge/` doesn't exist and a `pre-rebase` hook is
  executable (the same idea as `hasCommitHook`).
- A `pre-commit` / `commit-msg` failure during a reword **stops the rebase mid-way**. The op
  resolves `{status: 'stopped', stop: 'hook', hookOutput}`. The banner shows the output; the user
  fixes it and continues (the message file is still there) or aborts.
- A hook that hangs: the op is cancellable (§4.4).
- Signing: `commit.gpgSign` / `gpg.format` are respected. Every replayed commit is re-signed, so a
  pinentry or ssh-agent prompt may appear. A signing failure ("gpg failed to sign the data",
  "error: … signing failed") → `stop: 'other'` with `signingFailed: true` and git's message. We
  never add `-S` or `--no-gpg-sign`. `gpg.program` from the repo config is already a risky key
  (the Trust and Open prompt, `src/repo-trust.js`).
- No "skip hooks" option in this plan (F18, deferred).

### 3.10 Merge mechanics (for §8)

```
git merge --no-autostash --no-edit [--ff | --no-ff | --ff-only] -m <message> <sha>
git commit --no-edit --cleanup=strip      # "Commit and Merge": concludes with MERGE_MSG, or --file=- for an edited message
git merge --abort
```

`-m` gets its own argv element, and the message is built like `pullMergeMessage`
("Merge branch 'x' into y", as git words it). The in-progress state is
`MERGE_HEAD` (`repoState` = `merging`), `status.merge = {head: sha, name, message}` from
`MERGE_HEAD` / `MERGE_MSG` (comment lines stripped). This also finishes the M4 deferral
"pre-filling the summary from MERGE_MSG during a merge".

---

## 4. Backend API

### 4.1 Files

| File | Change |
|---|---|
| `src/rebase.js` (new) | `rebaseState`, `plan`, `start`, `startInteractive`, `continue_`, `skip`, `abort`, `restoreAutostash`, the state-folder helpers (`<git-dir>/pasta-lite/rebase/{meta.json,todo,msgs/}`), progress polling (R5). Uses `exec` and `git` helpers; keeps `git.js` from growing past 1k lines |
| `src/rebase-editor.js` (new) | The editor helper (§3.3) |
| `src/merge.js` (new, R2) | `mergeState`, `merge`, `mergeCommit`, `mergeAbort` |
| `src/git.js` | `status` adds `rebase` / `merge` / `pendingAutostash`; `pull` rebase mode uses the persistent autostash; `withAutostash` gains an `{persist: 'rebase'}` option |
| `src/exec.js` | `GIT_SEQUENCE_EDITOR: 'true'` in `baseEnv`; `run(..., {env})` already merges extra env |
| `src/ops.js` | New ops, validation, `EXTRA_FIELDS` += `count`, `stop`, `rebase`, `dropped`, `skippedCherryPicks`, `hookOutput`, `published` |
| `src/undo.js` | `rebase` / `merge` actions (§6) |
| `main.js` / `preload.js` | Nothing for ops (the allowlist is `ops.OPS`); R5 adds the `progress` event to preload's allowed events |

### 4.2 Operations

All the writes are queued per repo (the existing runner), emit `busy` / `changed`, and run under
`exec.withSignal`. "Refused" means refused in `check` (no events, nothing touched).

```js
// ---- reads
status()                     // + status.rebase (RebaseState|null), status.merge, status.pendingAutostash (sha|null)
rebasePlan({upstream, onto?}) -> {
  head: sha, branch: string|null, upstream: sha, onto: sha,
  commits: [{sha, parents, subject, message, author, date, isMerge}],   // oldest first, upstream..HEAD
  mergeBase: sha, isAncestor: boolean,        // onto already in HEAD (a plain rebase is then a no-op)
  published: [{sha, remoteRefs: ['origin/feat']}],  // commits reachable from any refs/remotes/* ref
  branchesInRange: ['stack/a'],               // local branches whose tip is in the range (R5 update-refs)
  limit: 500, truncated: false,
}
//   refused: invalid-args (not a commit), merge-commits (IR only; `commits` still returned for the message),
//            root-commit (the range includes a root commit), too-many (> 500 commits: IR refuses; plain rebase is fine)

// ---- writes
rebase(onto, {autostash = true, expectHead}) -> RebaseResult
rebaseInteractive({upstream, onto?}, todo, {messages, expectHead, autostash = true, updateRefs = false}) -> RebaseResult
rebaseContinue({message?}) -> RebaseResult
rebaseSkip() -> RebaseResult
rebaseAbort() -> {status: 'aborted', stash?: {...}}
restoreAutostash({keep = false}) -> {restored: boolean, stash?: {...}}
// R2: merge(target, {ff: 'ff'|'no-ff'|'ff-only', autostash = true, expectHead}) -> MergeResult
//     mergeCommit({message?}) -> {status: 'done', sha}   mergeAbort() -> {status: 'aborted'}

RebaseResult =
  | {status: 'up-to-date'}
  | {status: 'done', branch, before, after, fastForward, dropped: [sha], skippedCherryPicks: n,
     published: n,                 // rewritten commits that were on the branch's upstream (force-push prompt)
     undoRecorded: boolean, stash?: {kept: true, sha, reason: 'conflict'|'index'} }
  | {status: 'stopped', state: RebaseState}      // conflict / edit / hook / other
```

`todo` = `[{action: 'pick'|'reword'|'edit'|'squash'|'fixup'|'drop', sha}]` oldest first (the
renderer's newest-first list reversed by `PLRebase.toTodo`); R5 adds `{action: 'update-ref', ref}`.
`messages` = `{[sha]: string}`.

### 4.3 Validation (`check`)

Common: `status.state` must be `clean` for starts (else kind `in-progress`, with `state`), and must
be `rebasing` for continue / skip / abort (else kind `not-rebasing`). `expectHead` (a full sha the
renderer's plan or menu was built on) must equal HEAD, else kind `stale` ("The branch moved since
you opened this; review and try again"). Unborn HEAD → `invalid-args`.

`rebase(onto)`: `onto` → `commitId` (a full sha). `onto` is an ancestor of HEAD → resolves
`up-to-date` in `act` (so no hooks run).

`rebaseInteractive` (the security boundary: the todo comes from the renderer):

1. `upstream` and `onto` → `commitId`. `rebasePlan` is recomputed server-side with the same argv.
   Refuse `merge-commits`, `root-commit` and `too-many`.
2. `todo` must be an array of plain objects, length ≤ 500, and each `action` must be in
   `ALLOWED = ['pick','reword','edit','squash','fixup','drop']` (+ `'update-ref'` only when
   `updateRefs`). Anything else, **`exec`, `break`, `label`, `reset` and `merge` included**, →
   `invalid-args` ("Unsupported rebase command 'exec'"). No field besides `action` / `sha` / `ref`
   is read.
3. Every `sha` passes `git.OID` (full hex, the repo's object format) **and** is in the plan's set.
   Each plan commit appears **exactly once** (a missing one would be dropped silently, and
   `missingCommitsCheck=error` is the second guard). No duplicates.
4. The first non-`drop` entry isn't `squash` / `fixup` (kind `invalid-todo`: "The oldest commit
   can't be squashed: there is nothing before it to combine with").
5. `messages`: keys must be shas that are `reword` or the last member of a squash group (the one
   the helper will see). Values are non-blank strings ≤ 64 KB with no NUL. Every `reword` and every
   squash group needs one (the UI always prefills). Fixup-only groups need none.
6. `update-ref` (R5): `ref` must be `refs/heads/<name>` for a `branchesInRange` entry
   (`validateBranchName`), at most once each, and not the branch being rebased.
7. Nothing changes (all `pick`, original order, no messages): refused `nothing` ("Nothing to change").
8. The whole todo is `drop`: allowed (the branch ends at `onto`), and the renderer must have
   confirmed it (the flow always does, §5.4).

`rebaseContinue({message})`: no conflicted paths (kind `conflicts`, `count`), no unstaged changes
of tracked files (kind `dirty`, `paths` capped at 20). `message`: as §4.3 step 5, allowed only at a
`conflict` or `hook` stop of a merge-backend rebase, ours or external (it goes to
`msgs/<stopped-sha>`; the apply backend can't take one: `invalid-args`). Continuing a rebase that
isn't ours first clears the state folder, so messages prepared for an earlier (aborted) rebase
never reach it.

`rebaseSkip()`: refused `dirty` (`paths`, `count`) while tracked files have changes other than
the conflicted ones and the ones the stopped commit touches (`diff-tree -r REBASE_HEAD`), since
git's skip resets the tree; refused `invalid-args` at an `edit` stop (the commit is already made).

Starts also take `expectBranch` (the checked-out branch's short name, or `null` for a detached
HEAD): a different one is `stale`.

Messages and paths are never logged (the ops runner's log record never includes args). The todo and
message files are written with `writeNoFollow`-style exclusive creation inside the git dir, after
checking that `<git-dir>/pasta-lite` isn't a symlink.

### 4.4 Cancellation, queueing, what can't be interrupted

| Phase | Cancellable | Why |
|---|---|---|
| Validation, `rebasePlan`, the autostash push | Yes (like any op) | Nothing written yet, or only a stash that the cancel path re-applies |
| `git rebase` / `--continue` / `--skip` running (hooks, signing, big repos) | **Yes, softly**: SIGTERM to the process group (exec's existing `kill`), never SIGKILL except in the quit path | git's lockfile code removes `index.lock` / ref locks on SIGTERM, so the repo is left **in a stopped rebase**, which the banner shows (Abort restores everything). The op rejects `aborted` with `rebase: RebaseState` so the flow says "Rebase stopped: continue or abort it" |
| `git rebase --abort`, the autostash re-apply after finish or abort, `restoreAutostash`, the undo record | **No** (run under `withSignal(undefined)`, like undo's reversal) | Stopping half-way would leave changes neither in the tree nor re-applied. `quit-guard.js` already waits for such phases |

The toolbar's busy area shows **Cancel** for `rebase`, `rebaseInteractive`, `rebaseContinue` and
`rebaseSkip` (they are started with `{cancellable: true}`, which publishes `state.remoteOp`; R1
renames that key's meaning to "a cancellable op" and keeps its name to avoid churn). Quitting
during a rebase op follows the quit guard: Cancel and Quit sends the cancel (the repo is then
mid-rebase on disk, which is fine: the next launch shows the banner).

Queueing: one write per repo at a time, as today. The renderer's flows also refuse while
`state.busy` (flows contract). A second `rebase` queued behind the first fails `in-progress` at
its `check`.

### 4.5 Error kinds (new)

`in-progress` (another operation is in progress; `state`), `not-rebasing`, `conflicts` (reused,
+ `count`), `dirty`, `stale` (reused), `nothing` (reused), `invalid-todo`, `merge-commits`,
`root-commit`, `too-many`, `checked-out-elsewhere`, `hook-failed` (reused: `pre-rebase`),
`rebasing` (commit refused at a conflict stop), `stash-conflict` (reused). The user-facing
ones are in `Components.util.EXPECTED_KINDS`, derived from `src/error-kinds.js` (renderer logging in `renderer/components.js`).

### 4.6 Events

No new event types for R1–R4: `busy` / `changed` after every write that started (including
stopped and failed ones), and the watcher's `full` for `rebase-merge/` changes made by a terminal.
R5 adds `progress {repo, op, opId, step, total, subject}`: the rebase op polls `rebase-merge/done`
every 250 ms while git runs (a read of our own git dir, no git process) and the runner forwards
it. Preload allows `progress`. The store keeps `state.progress`, which the banner shows as
"Rebasing commit 3 of 7".

---

## 5. UI / UX

### 5.1 Menus (descriptor contract of `renderer/actions.js`)

`<cur>` = the checked-out branch's display name (or "HEAD" when detached). Every item goes through
`finishItems` + `gateItems`, and a new `gateItems` rule disables starts while
`status.state !== 'clean'` ("A rebase is in progress: continue or abort it first").

| Location | Items (R2 unless marked) |
|---|---|
| Sidebar local branch `b` ≠ current | `Merge <b> into <cur>` · `Rebase <cur> onto <b>` · `Interactive Rebase <cur> onto <b>` (R3). The menu always moves `<cur>`: there is no `Rebase <b> onto <cur>…` item (that direction is left to an R4 drop onto a branch that isn’t checked out, §5.2, through the flow’s `branch` option, §3.7). When `b` is behind its upstream and the merge / rebase is a no-op, the reason says so: "`<cur>` is already based on main — main is 2 behind origin/main: rebase onto origin/main instead" |
| Sidebar current branch | `Rebase <cur> onto <upstream>` when it has an upstream (the same as Pull (rebase) without the fetch; label "Rebase onto origin/x") · `Interactive Rebase <cur> onto <upstream>` (R3) |
| Sidebar remote branch `origin/x` | `Merge origin/x into <cur>` · `Rebase <cur> onto origin/x` · `Interactive Rebase <cur> onto origin/x` (R3) |
| Sidebar tag | `Rebase <cur> onto <tag>` · `Merge <tag> into <cur>` |
| Graph commit row, **not** an ancestor of HEAD | `Rebase <cur> onto this commit` · `Interactive Rebase <cur> onto this commit` (R3) · `Merge this commit into <cur>` |
| Graph commit row, ancestor of HEAD (HEAD's history) | `Interactive Rebase <n> children of <sha7>` (R3; hidden for HEAD itself, for merge rows, or when the range has merges; disabled with a title) · R5: `Reword commit…` · `Drop commit…` · `Squash into parent…` (not for the root commit) |
| Graph ref pill (new: right-click on a pill; today only the row menu exists) | The same list as the sidebar row for that ref (reuse `sidebar.js` `branchMenuItems`, moved to a shared `refMenuItems(ref, state)` in `actions.js`) |

A disabled item's reason (its `title`) is shown under its label in `Components.menu`
(`.pl-menu-hint`, secondary text colour; `aria-hidden`, with the row's `aria-description` carrying
it), so a no-op such as "already based on main" reads without hovering.

"Ancestor of HEAD" is computed in the renderer over **loaded** commits: `store.headAncestors()`
walks parents from HEAD over the loaded rows (cached per `logSig`). This is exact: `--date-order`
never shows a parent before all its children, so every commit between HEAD and a shown commit is
loaded too. The backend re-checks (`rebasePlan.isAncestor`).

### 5.2 Drag and drop (R4)

- **Sources:** the local/remote branch pills in the graph's BRANCH/TAG column, and local/remote
  rows in the sidebar. **Targets:** the same, plus graph commit rows (for "Rebase onto this
  commit").
- Pointer events, not HTML5 DnD: a 6 px move threshold, then a drag ghost (the pill's
  label). Targets highlight with the `--blue-hover` token, and Esc cancels. The row under the
  pointer is found with `elementFromPoint`, so the graph's recycled rows need no per-row
  listeners. Synthetic `pointerdown/move/up` events drive the smoke tests.
- Drop on a target → `Components.menu.open({x, y}, items)`. Items:
  `Merge <src> into <cur>` · `Rebase <cur> onto <src>` · `Interactive Rebase <cur> onto <src>` · `Fast-forward <target> to <src>` (only
  when the target is a local branch that is an ancestor of the source; `update-ref` for a
  non-checked-out target, or `merge --ff-only` for the current one) · separator · Cancel. When
  the *target* isn't the current branch, the items are phrased for it (`Rebase <target> onto
  <src>…` needs the checkout, §3.7).
- **Alt/Option held at drop** → skip the popup and open the interactive editor for "`<cur>` onto
  `<src>`" (F4).
- A drop onto itself, or while busy or mid-rebase, does nothing. Dragging the current branch onto
  another branch means "rebase current onto that".
- Keyboard equivalent (accessibility): the existing context menus. The drag has no keyboard
  version of its own.

### 5.3 The operation banner (R1)

A new component `renderer/components/op-banner.js` (+ `.css`) mounts into a new
`data-component="op-banner"` region between the toolbar and the main area in `index.html`. It is
hidden unless `status.state !== 'clean'` or `status.pendingAutostash`. It uses `role="status"`
(polite) for text changes, and its buttons are real buttons in the Tab order.

| State | Text (textContent, names through `displayName`) | Buttons |
|---|---|---|
| Rebase, conflict stop | **Rebasing feat onto main** · Commit 3 of 7: "subject" · 2 conflicted files | **Continue Rebase** (disabled while conflicts remain, title "Resolve and mark all conflicted files first") · **Skip Commit** · **Abort Rebase** |
| Rebase, edit stop | **Rebasing feat onto main** · Stopped to edit a1b2c3d "subject": change it, then continue. Staged changes will be amended into it | **Continue Rebase** · **Abort Rebase** |
| Rebase, hook / other stop | … · "A commit hook refused the reworded message:" + the output in a `<pre>` (collapsed to 3 lines) | Continue · Skip · Abort |
| External rebase | **Rebase in progress** (started outside Pasta Lite) · Commit 3 of 7 | Continue · Skip · Abort (no todo editing) |
| Merge (R2) | **Merging feat into main** · 2 conflicted files | **Commit and Merge** (disabled while conflicts) · **Abort Merge** |
| Other states (`cherry-picking`, `reverting`, `am`, `bisecting`, `sequencer`) | "A cherry-pick is in progress. Finish or abort it from a terminal." | none |
| Pending autostash | Your changes from before the rebase are in a stash | **Restore** · **Keep in Stash** |
| While a rebase op runs (R5) | Rebasing commit 3 of 7 (progress event) | Cancel (the toolbar's) |

Flows (`renderer/flows.js`, same contract as the other flows in `renderer/flows-kit.js`: take the store, resolve boolean, never throw):
`rebaseContinue`, `rebaseSkip` (danger confirm: "Skip 'subject'? Its changes will be left out of
the rebased branch. Your edits to its conflicted files are discarded."; Cancel focused),
`rebaseAbort` (confirm: "Abort the rebase? feat goes back to where it was before the rebase
(a1b2c3d)." — not a danger dialog, because nothing is lost: our autostash comes back),
`restoreAutostash`, plus R2's `merge`, `mergeCommit`, `mergeAbort`.

### 5.4 WIP panel during a rebase or merge (R1)

- The **WIP row stays in the graph** while `status.state !== 'clean'`, even with a clean tree (an
  edit stop). `store.js` `layoutRows` uses `isDirty(st) || st.state !== 'clean'`. The WIP row's
  label becomes "// Rebasing 3/7" or "// Merging".
- `details.js` WIP view: a header block "Rebase conflicts detected" (or "Merge conflicts detected") with the count. The existing
  Conflicted section is titled "Conflicted Files (n)". R2 adds a section action **Mark all
  resolved** and per-file hover actions **Keep main's version** / **Keep a1b2c3d's version**
  (`checkout --ours|--theirs -- <path>` + `add`, new op `resolveWith(path, side)`). During a
  rebase **ours = the commit being built on (`onto` / already-replayed commits) and theirs = the
  commit being replayed**, the reverse of a merge. So the labels name the branch or commit and never
  say ours/theirs. Modify/delete conflicts offer "Keep file" / "Delete file" instead.
- The **composer switches mode** (`composer.js`, driven by `status.rebase` / `status.merge`):
  - Conflict stop: summary/description prefilled from `rebase.stopMessage` (the draft is saved
    separately, keyed by `stoppedSha`). The button reads **Continue Rebase**. ⌘↵ runs it (the
    `commit` KEYS entry maps to Continue in this mode, and the hint follows). The Amend checkbox is
    hidden, and ⌘⇧↵ (stage all and commit) is disabled with "Stage resolved files one by one: all
    conflicts must be resolved first". If the message is unchanged, no `message` is sent.
  - Edit stop: the normal composer (Commit / Amend work, the backend allows them at an edit stop)
    plus a **Continue Rebase** button under it.
  - Merge: summary prefilled from `MERGE_MSG`, button **Commit and Merge**.
- Conflict diff: the existing read-only combined-diff view (`diffView` `conflict`). Unchanged.

### 5.5 Toolbar and actions while rebasing (R1)

`Components.actions.availability(state)` gets `opState = status.state` (and `status.rebase`):

| Action | While rebasing / merging |
|---|---|
| Undo / Redo | disabled (already: `undo.busy`) |
| Pull, Pull menu, Push | disabled: "Pull — a rebase is in progress" |
| Fetch (⌘L) | **enabled** (it only updates remote-tracking refs) |
| Branch (⌘B), Stash, Pop, branch switcher, checkout / delete / merge / rebase items | disabled: "… — finish or abort the rebase first" |
| Terminal | enabled |
| Commit / Commit All | per §5.4 |

`shortcutFor` / `shortcutBlocked` pick this up for free (they are gated by `availability`).

### 5.6 The interactive rebase view (R3)

The interactive-rebase view has a header with the commit count and target, a per-commit action
(pick / reword / squash / fixup / drop / edit), drag to reorder, one-key shortcuts, and reset,
cancel and start buttons.

- **Component:** `renderer/components/rebase-editor.js` (+ `.css`) mounted into a new
  `data-component="rebase-editor"` centre region that **replaces the graph** while
  `state.rebaseEditor` is set, the same way `diff-view` does (graph hidden, not destroyed).
  The pure model is in `renderer/components/rebase-model.js` (`window.PLRebase`,
  unit-tested). The store gets `actions.openRebaseEditor(plan)` / `closeRebaseEditor()`, and
  `state.rebaseEditor = {plan, model}`.
- **Layout** (newest at the top, like the graph):
  ```
  Interactive Rebase                           Rebasing 5 commits of feat onto main (9f3c2e1)
  ⚠ 3 of these commits are already on origin/feat: you'll need to force push afterwards.
  ┌──────────┬──┬────┬──────────────────────────────────────┬─────────┬────────┐
  │ [Pick ▾] │⋮⋮│ AV │ c5 subject                           │ 1a2b3c4 │ 2h ago │
  │ [Squash▾]│⋮⋮│ AV │ c4 subject      ↳ into c3            │ …       │        │
  │ [Reword▾]│⋮⋮│ AV │ c3 new subject ✎                     │ …       │        │
  │ [Drop ▾] │⋮⋮│ AV │ ~~c2 subject~~                       │ …       │        │
  │ [Pick ▾] │⋮⋮│ AV │ c1 subject                           │ …       │        │
  ├──────────┴──┴────┴──────────────────────────────────────┴─────────┴────────┤
  │ ● main  9f3c2e1  "base subject"   (onto — not editable)                    │
  └─────────────────────────────────────────────────────────────────────────────┘
  3 picked · 1 reworded · 1 squashed · 1 dropped      [Reset] [Cancel]  [Start Rebase]
  ```
  Each action is a native `<select>` (accessible for free). Rows use `role="row"` in a
  `role="grid"`, and the focused row has `aria-selected`. Squashed rows are indented with "↳ into
  <subject>". Dropped rows are struck through and dimmed. Rewordable rows show ✎ (click or Enter
  opens the message dialog).
- **Keyboard** (the editor owns keys while it has focus; `util.modalOpen` / `inTextField` guards as
  elsewhere):

  | Key | Action |
  |---|---|
  | ↑ / ↓, j / k, Home / End | move focus between rows |
  | p / r / e / s / f / d | set Pick / Reword / Edit / Squash / Fixup / Drop (the usual one-key shortcuts, plus e and f) |
  | ⌥↑ / ⌥↓ (Alt+Up/Down elsewhere) | move the focused commit up / down one row; focus follows; an `aria-live` note "c3 moved to position 2 of 5" |
  | Enter | edit the message (reword / squash head); on the select: opens it |
  | ⌘↵ / Ctrl+Enter | Start Rebase |
  | ⌘Z inside the editor | undo the last model change (a local history stack; Reset clears it) |
  | Esc | Cancel (confirm "Discard your rebase plan?" only when the model changed) |

  Mouse: drag the ⋮⋮ handle to reorder (pointer events, a drop indicator line, auto-scroll near
  the edges). Setting an action with a click on the select.
- **Validation** (`PLRebase.validate(model)`; errors disable Start Rebase and show under the row,
  warnings show in the header):
  - error `squash-first`: the bottom-most kept row is Squash/Fixup ("The oldest commit can't be
    squashed: there's nothing below it to combine with").
  - error `empty-message`: a reword or squash group with a blank message.
  - error `nothing`: nothing changed ("Nothing to rebase: change an action or the order").
  - warning `all-dropped`: every commit dropped ("feat will be reset to main"), with a second
    confirm on Start.
  - warning `published`: from `plan.published`.
  - warning `hash-lines`: a message with lines starting with `#` (§3.6).
  - info: "Rewording c3 rewrites 3 commits".
- **Reword / squash dialog**: new `Components.dialog.editMessage({title, summary, description,
  okLabel, validate})` (summary input with the 72-char counter from `wip-model.js`, description
  textarea, ⌘↵ = OK). A squash group prefills with the target's message followed by each squashed
  commit's message, with a blank line between, and no `#` comment lines. Fixup keeps the target's
  message and doesn't open the dialog.
- **Start Rebase** → the flow runs `rebaseInteractive` with `expectHead`. On `done`: close the
  editor, notice "Rebased feat: 5 commits → 3", then the force-push follow-up (§5.7). On `stopped`:
  close the editor. The banner and WIP panel take over. On `stale`: keep the editor open with
  "The branch moved since you opened this plan" and **Reload** (re-reads the plan and keeps the
  actions of commits that still exist).

### 5.7 Published commits and the force-push follow-up (R2)

- **Before** a rebase (plain or interactive) whose range contains commits in `plan.published`, a
  confirm: title "Rewrite pushed commits?". Message: "3 of the commits you're rebasing are already on
  origin/feat. After the rebase, feat and origin/feat will have diverged and you'll need to force
  push, which replaces the remote branch for everyone." Buttons: **Rebase Anyway** / Cancel
  (Cancel focused; not a danger style, since nothing is lost locally and undo exists after R5).
- The branch *is* the default branch of its remote (`refs/remotes/<r>/HEAD` points at it) or is
  named `main` / `master` / `develop`: the same dialog uses a danger style and the extra line
  "feat is the main branch of origin". A configurable list is deferred (Q3).
- **After** a `done` result with `published > 0` and an upstream: `dialog.choose` "feat and
  origin/feat have diverged" with **Force Push…** (reuses `flows.js` `forcePush`, `force: 'lease'`,
  its own danger confirm) and **Later** (primary). The lease uses the remote-tracking ref's current
  value, which a rebase never moves, so a teammate's push in between is still caught ("stale info",
  flow 7h of the milestone 7 run). Never offered: a plain force push without a lease.

### 5.8 Wording, shortcuts, notices

- Notices: "Rebased feat onto main" · "feat is already up to date with main" · "Rebase stopped:
  2 conflicted files" · "Rebase aborted: feat is back at a1b2c3d" · "2 commits became empty and were
  dropped" · "3 commits were already in main and were skipped" · "Merged feat into main" ·
  "Rebase stopped: continue or abort it" (cancelled). Errors use the existing toast path.
- New `Components.actions.KEYS` entries: none global in R1–R4 (rebase starts come from menus; ⌘↵
  is reused in context). The interactive editor's keys are local (above). Open question: a global
  "Continue" shortcut.
- Pull's conflict alert (`pullError` `conflicts`) changes to "Pulling into feat stopped with
  conflicts. Resolve them in the WIP panel, then click Continue Rebase in the banner."

### 5.9 Screenshots to produce (smoke-run style, R5)

`r1-banner-conflict.png`, `r1-wip-continue-mode.png`, `r1-pull-rebase-continue.png`,
`r1-external-rebase.png`, `r1-pending-autostash.png`, `r2-merge-conflict.png`,
`r2-sidebar-menu-rebase.png`, `r2-graph-menu-rebase.png`, `r2-published-warning.png`,
`r2-force-push-followup.png`, `r2-keep-version.png`, `r3-editor-initial.png`,
`r3-editor-edited.png` (reorder, squash, drop, reword), `r3-squash-first-error.png`,
`r3-reword-dialog.png`, `r3-edit-stop.png`, `r4-drag-ghost.png`, `r4-drop-popup.png`,
`r5-undo-rebase.png`, `r5-progress.png`.

---

## 6. Undo / redo integration (R5)

Today a rebase **disables undo**: the newest HEAD reflog entry is `rebase (finish): returning to
refs/heads/<b>`, which `undo.js` doesn't recognise, so the walk stops (that already happens after
every Pull (rebase)). Plan:

1. **Record.** When a rebase op (or merge, or Pull (rebase)) finishes, it writes a record commit,
   the same pattern as the discard backups: `commit-tree <empty tree> -p <before> -p <after>` with
   the fixed identity `Pasta Lite <pasta-lite@localhost>`, `--no-gpg-sign`, and a JSON body
   `{branch, before, after, updatedRefs: [{ref, old, new}]}`. It is kept alive by
   `refs/pasta-lite/rebases/<record>`, and the HEAD reflog gets
   `rebase: [<record>] <branch|->` (via `reflog write`, git ≥ 2.51). If recording fails, the result has `undoRecorded: false` and a
   warning, as `deleteBranch` does.
2. **Fallback for rebases finished outside our ops** (terminal, or an older version of the app): the
   HEAD entry `rebase (finish): returning to refs/heads/<b>` (old == new == after) pairs with the
   branch log's newest `rebase (finish): refs/heads/<b> onto <sha>` whose new == after; its old is
   `before` **(verified entry shapes)**. Parsed with strict regexes, and the branch name is checked
   with `validateBranchName` (reflog text is data).
3. **Walk rules** (`findTargets`): a `rebase:` record or a recognised `rebase (finish)` is the
   action. When the walk passes a *cancelled* one (undone), it also skips that run's internal
   entries back to and including its `rebase (start)`: `rebase (pick|reword|edit|squash|fixup|
   continue|skip)`, `rebase: fast-forward`, `rebase (finish)`. An **aborted** run
   (`rebase (start)` … `rebase (abort): returning to …` whose end equals its start's old) is a
   no-op and is skipped too, so an aborted rebase no longer blocks undo of the commit before it.
4. **Check (undo):** `repoState` clean. HEAD is on `branch` (or detached at `after` for `-`).
   The branch tip == `after`. `before` exists. **The worktree and index are clean** (untracked
   files are allowed) — else `undoBlocked: "Commit or stash your changes first"`, so an undo never
   mixes the user's uncommitted work into the restored state. The undo flow offers
   **Stash & Undo** (stash, undo, pop).
5. **Apply (undo):** `git read-tree -m -u <after> <before>` (a two-tree switch of index and
   worktree; it refuses if anything local would be overwritten), then
   `git update-ref -m "undo: rebase: [<record>] <branch>" refs/heads/<branch> <before> <after>`.
   `reset --keep` was rejected: it logs `"<GIT_REFLOG_ACTION>: updating HEAD"` **(verified)**,
   which breaks the exact `undo: <msg>` matching. Then each `updatedRefs` entry still at `new`
   goes back to `old` with `update-ref <ref> <old> <new>`. Not cancellable (as today). If
   `update-ref` fails after `read-tree`, the reverse `read-tree -m -u <before> <after>` runs and
   the error is rethrown.
6. **Redo:** the mirror image. Offered while the tip == `before` and the tree is clean; it moves to
   `after`.
7. Merge undo uses the same record (`merge: [<record>] <branch>`) and handler, which also makes
   today's "merge commits are not undoable" rule obsolete for merges made by the app.
8. Description: "Undo rebase of feat onto main" / "Undid rebase of feat". Tests in §9.

---

## 7. Security summary

- The todo comes from the renderer: allow-listed commands, full shas that must be in the
  server-computed range, each exactly once; **no `exec` (or `break`/`label`/`reset`/`merge`), ever**;
  git's `missingCommitsCheck=error` as a second guard; the backend writes the file.
- The editor command strings are constants. Data goes through one env var only (`PL_GIT_DIR`);
  the editor checks that the file git gave it is the expected file in the git dir.
- Messages go only into files under `<git-dir>/pasta-lite/rebase/msgs/`, never into argv or env,
  and are never logged.
- `GIT_SEQUENCE_EDITOR=true` joins `GIT_EDITOR=true` in `baseEnv`. No app binary runs as the
  editor, so the packaged app ships with the runAsNode fuse off.
- Undo reads reflog text as data (strict regexes, `validateBranchName`, full shas).
- `sequence.editor` and `core.editor` are risky keys (`RISKY_CONFIG`, `src/git.js`): the app
  overrides them with `GIT_SEQUENCE_EDITOR` / `GIT_EDITOR`, but a terminal git in the same repo
  would run them, so a repo that sets them asks Trust and Open first (Q10, resolved).

---

## 8. Merge: build it first (R2, first half)

**Recommendation: build merge first, right after R1, and before the rebase menus.**

- A user asked for it, and today the app can only merge through Pull (ff-if-possible).
- It is a quarter of the work of rebase (one stop, no todo, no editor helper) and exercises all of
  R1's shared plumbing end to end: the banner, the WIP conflict mode, Keep-a-side / Mark resolved,
  "conclude" (Commit and Merge ≈ Continue), abort, the autostash marker, toolbar gating, and later
  the undo record.
- The drag-and-drop popup (R4) offers Merge and Rebase side by side, so both must exist.
- It closes the M4 deferral (MERGE_MSG prefill).

Scope: `merge(target, {ff})` from the same menu locations (`Merge <x> into <cur>`), `ff` chosen by
a setting-free rule (fast-forward if possible, like the pull default; a "Create a merge commit"
checkbox in the confirm when a fast-forward is possible), a `conflicts` stop resolving
`{status: 'stopped'}`, `mergeCommit({message?})` (`git commit --no-edit` or `--file=-` with the
edited message; the author is the user, which is correct for a merge), `mergeAbort()`
(`merge --abort`, then our autostash). Squash merge ("Commit and Squash Merge"): **defer**.

---

## 9. Testing strategy

Suites stay on `node:test` against scratch repos (`test/helpers.js` `initRepo`,
`repoWithRemote`), **all under `hostileConfig`**. R1 extends `hostileConfig` with
`rebase.autoSquash=true`, `rebase.autoStash=true`, `rebase.updateRefs=true`,
`rebase.missingCommitsCheck=ignore`, `rebase.abbreviateCommands=true`,
`rebase.instructionFormat=%an`, `rebase.backend=apply`, `sequence.editor=false`,
`core.editor=false`, `commit.cleanup=verbatim`, `core.commentChar=;`, `merge.conflictStyle=zdiff3`.

### 9.1 `test/rebase.test.js` (git layer, new)

| Scenario | Asserts |
|---|---|
| Plain rebase, no conflicts | new base, subjects and authors kept; result `done`, `before` / `after`; `other` branch untouched despite `rebase.updateRefs=true` |
| Up to date / fast-forward | `up-to-date` without running `pre-rebase` (a marker hook); `fastForward: true` |
| Conflict at step N (N = 1, 3, last) | `stopped`, `stop: 'conflict'`, `step` = {N, total}, `current.sha`, `stopMessage` without `# Conflicts` lines; `branch` from head-name while `status.branch` is null |
| Continue with unresolved paths / with unstaged changes | refused `conflicts` (`count`) / `dirty` before git runs |
| Continue after resolving; with an edited message | the original author kept; the edited message used (through the helper); `hostileConfig`'s verbatim cleanup doesn't leak `#` lines |
| Resolution identical to onto (nothing to commit) | the commit dropped, `dropped: [sha]` |
| Skip at step N | the commit absent, the rest applied; untracked files kept |
| Abort at step N | branch == before, tree == before, `rebase-merge/` gone, `.git/pasta-lite/rebase` gone |
| Autostash (staged + unstaged + untracked) → clean finish | the split restored exactly; stash list back to what it was; `refs/pasta-lite/autostash` gone |
| Autostash + conflict → abort | the changes back with the split; ref gone |
| Autostash + conflict → continue → re-apply conflicts | `done` with `stash: {kept}`, tree reset to HEAD, stash kept |
| Autostash + external finish (the test runs `git rebase --continue` itself) | `status.pendingAutostash` set; `restoreAutostash` restores it |
| `pre-rebase` hook exits 1 | `hook-failed` with its output; nothing changed; no `rebase-merge/` |
| A `commit-msg` hook rejects a reword | `stopped`, `stop: 'hook'`, `hookOutput`; continue after fixing the hook finishes |
| Detached HEAD rebase | result detached at the new tip; `branch: null` |
| Non-checked-out branch (flow sequence checkout + rebase) | branch rebased, previous branch untouched; checked out in another worktree → `checked-out-elsewhere` |
| Cancel during a slow hook | rejects `aborted` with `rebase` state; no `index.lock`; abort restores |
| Apply-backend rebase started by the test | state readable (`backend: 'apply'`); continue / abort work |
| sha256 repo | shas validated with the 64-hex OID, todo written and applied |

### 9.2 Interactive (`test/rebase-interactive.test.js`)

pick-only reorder (the tree identical, the order changed) · reword (message, author, other commits
untouched) · squash group of 3 (one commit, combined message as given, author of the first) ·
fixup (the target message kept) · drop (the commit gone, others kept) · drop everything (the branch
at onto) · `edit` stop (exit code 0, `stop: 'edit'` from the `amend` file, **verified**), then
amend through `ops.commit({amend})` and continue · a conflict after a reorder · a todo sha git
can't resolve (simulated by a stale plan) → the op aborts the half-started rebase (`invalid-todo`,
no `rebase-merge/` left) · `--update-refs` (R5): a stacked branch moves, its reflog says
"rewritten during rebase" **(verified)**.

Validation refusals, each proving **nothing ran** (no `rebase-merge/`, no events): `exec` / `break`
/ `label` / `reset` / `merge` / unknown actions · abbreviated sha · a sha outside the range · a
duplicate · a missing commit · squash first · a blank message · non-object entries or extra fields
· > 500 entries · a range with a merge commit (`merge-commits`) · a range containing the root
(`root-commit`) · `expectHead` mismatch (`stale`) · a symlinked `.git/pasta-lite` (refused).

### 9.3 `ops.test.js` / `undo.test.js`

- ops: the runner emits `busy`/`changed` for a stopped rebase; `rebaseAbort` isn't cut by
  `cancelAll` (like undo); `commit` refused at a conflict stop (`rebasing`) but allowed at an edit
  stop; `serializeError` carries `count` / `rebase`.
- undo: undo/redo of a recorded rebase (branch, tree, reflog `undo: rebase: …`) · blocked with a
  dirty tree (reason text) · blocked after the branch moved · a terminal-finished rebase via the
  `rebase (finish)` fallback · an aborted run no longer blocks undo of the previous commit ·
  undoing a rebase then the commit before it · an `update-refs` rebase restores the stacked branch
  too · undo of a merge made by the app.

### 9.4 Renderer (pure + harness)

- `test/rebase-model.test.js`: `fromPlan`, `setAction`, `move` (by one row, to the top or bottom,
  out of range), `reset`, `validate` (every code), `toTodo` (newest-first to oldest-first),
  `messages` (keys: reword sha / last member of a squash group), squash group prefill text,
  `summary` counts.
- `test/flows.test.js`: every new flow branch with scripted dialogs (published warning, force-push
  follow-up, skip confirm, abort, `stale` reload, `stopped` hand-off, cancel notice).
- `test/actions.test.js` / `keys.test.js`: availability while rebasing / merging (the table in
  §5.5); `gateItems` disables starts; ⌘↵ maps to Continue in rebase mode.
- `test/sidebar-actions.test.js` (fake DOM): the new menu items per location; the banner's buttons
  and states; the editor's keyboard (p/r/s/f/d/e, ⌥↑/⌥↓ with the live note, Enter, ⌘↵, Esc with
  and without changes), focus handling, and pointer-drag reorder with synthetic events.
- `test/store.test.js`: `headAncestors()` over paged history; the WIP row kept mid-rebase with a
  clean tree; `rebaseEditor` state lifecycle.

### 9.5 Property / fuzz tests

- **Todo vs cherry-pick:** a generated repo where each of N (5–12) commits touches its own file
  (so no conflicts). A random permutation with random `pick`/`drop` → `rebaseInteractive` → the
  resulting commit list must equal cherry-picking the kept commits in that order onto the base in a
  scratch clone: the same subjects in order, the same `patch-id`s, the same final tree. 200 seeded
  iterations, with the seed printed on failure.
- **Squash algebra:** random squash/fixup groups → the final tree equals the plain-pick result; the
  commit count equals the number of groups; the messages are exactly the ones passed.
- **Model:** a random sequence of `move`/`setAction`/`reset` keeps `toTodo` a permutation of the
  plan's shas, and `validate` never accepts squash-first.
- **Validator fuzz:** random JSON (strings, long arrays, prototype-polluting keys such as
  `__proto__`, Unicode, `exec`-like strings, NUL) never reaches git (a spy on `exec.run` records no
  `rebase` call) and always fails `invalid-args`/`invalid-todo`.
- **Helper:** `rebase-editor.js` refuses paths outside the git dir, other basenames and symlinks;
  exits 0 without a message file.

### 9.6 Smoke E2E (as in the milestone 7 run)

Scripts through `PL_SMOKE_JS`, clicking the real controls, with git checks after each run, on a
copy of this repo plus a bare remote and a teammate clone. Flows: (1) Pull (rebase) conflict →
resolve (write the file from the script, then Mark resolved) → Continue in the banner → the
autostash restored; (2) Merge from the sidebar menu with a conflict → Keep version → Commit and
Merge; (3) Rebase onto a branch from the graph menu → published warning → force-push follow-up →
the remote updated with lease; (4) interactive editor via keyboard only (open from the commit
menu, p/r/s/d, ⌥↑, reword dialog, ⌘↵) → the result checked with `git log`; (5) drag a pill onto
another → popup → Rebase; Alt-drop → editor; (6) an edit stop → amend → Continue; (7) Abort
mid-way with autostash; (8) Undo the rebase, then Redo; (9) a terminal-started rebase shows the
external banner and can be aborted in the app; (10) cancel a rebase blocked in a slow `commit-msg`
hook. The 30 s smoke timeout means long flows are split as in M7.

---

## 10. Milestones

### R1: backend foundation, in-progress state, Continue / Skip / Abort

- **Scope:** `src/rebase.js` (`rebaseState`, `continue`, `skip`, `abort`, the state folder,
  `restoreAutostash`), `src/rebase-editor.js` (the `msg` role is needed by Continue with a
  message; `todo` lands in R3 but is tested here), `status.rebase` / `status.merge` /
  `pendingAutostash`, `GIT_SEQUENCE_EDITOR=true`, the persistent autostash for Pull (rebase), ops
  `rebaseContinue` / `rebaseSkip` / `rebaseAbort` / `restoreAutostash`, the `commit` refusal at a
  conflict stop, the op banner, WIP conflict mode and composer Continue mode, the toolbar/actions
  gating, flows, and `mergeAbort` / `mergeCommit` for merges started by Pull or a terminal.
- **Acceptance:** a conflicted Pull (rebase) can be resolved, continued and finished in the app
  with the local changes restored (split intact). Abort restores exactly. External rebases and
  merges show the banner and can be continued or aborted. Nothing in the toolbar can start a
  conflicting op mid-rebase. All §9.1 rows that don't need `rebase()` pass under `hostileConfig`.
- **Size:** 4 new files, ~12 touched; ~1.2k LOC code + ~1.2k tests.
- **Risks:** composer mode switching (drafts per stop); the WIP row appearing with a clean tree
  changes the graph layout key (`wipKey`); a SIGTERM cancel leaving a lock on some platform (test
  on macOS and Linux CI).

### R2: merge, then non-interactive rebase from menus

- **Scope:** `src/merge.js` + `merge` op + flows + menu items; `rebase(onto)` + `rebasePlan` (for
  the published check) + menu items in the sidebar, graph rows and ref pills (`refMenuItems`
  shared); the checkout-first flow; the published warning; the force-push follow-up;
  `resolveWith(path, side)` + "Mark all resolved"; `headAncestors()`.
- **Acceptance:** each menu item does what its label says in a scratch repo, from mouse and
  keyboard (ContextMenu key). The published warning appears exactly when commits are on a remote
  ref. After confirming, the force push is refused if the teammate pushed meanwhile (the lease).
  The counterparts of flows 7d/7e of the milestone 7 run pass for merge and rebase from menus.
- **Size:** 2 new files, ~10 touched; ~1.1k code + ~1.1k tests.
- **Risks:** the ours/theirs naming during rebase (test both directions); menu growth (keep items
  grouped with separators); detached HEAD wording.

### R3: interactive rebase

- **Scope:** `rebasePlan` (full), `rebaseInteractive` with the allow-list validator, the `todo`
  helper role, `PLRebase` model, `rebase-editor` component (list, selects, keyboard, pointer
  reorder, validation, footer), `dialog.editMessage`, entry points (commit row "children of",
  "Interactive Rebase X onto Y" items), edit stops in the banner/composer.
- **Acceptance:** every §9.2 scenario passes, including all the validation refusals; the property
  tests pass for 200 seeds; the editor is fully usable without a mouse (verified in the smoke
  flow 4); a stale plan is detected and reloadable.
- **Size:** 4 new files, ~8 touched; ~1.6k code + ~1.4k tests.
- **Risks:** the editor helper under a packaged app (asar: the helper must be unpacked or run from
  `app.asar.unpacked`; Electron-as-Node reads asar, but verify); Windows `sh` behaviour (§12);
  large ranges (cap at 500, virtualize the list above 200 rows by reusing the graph's row pool
  pattern); message prefill for long squash groups.

### R4: drag and drop

- **Scope:** pointer-drag from graph pills and sidebar rows, drop targets, the ghost, the popup,
  Alt-drop, fast-forward item (`update-ref` for a non-current branch with an old-value check, or
  `merge --ff-only` for the current one: new op `fastForward(branch, to)`).
- **Acceptance:** drags between every source/target pair open the right popup; Esc and drops on
  nothing cancel; no accidental drags from clicks (threshold); virtualized graph rows still work
  while scrolling during a drag (auto-scroll at the edges).
- **Size:** 1 new file (`renderer/dnd.js`, pure hit-testing + controller), ~4 touched; ~600 code
  + ~600 tests.
- **Risks:** conflicts with the graph's mousedown selection and double-click checkout; the pill
  column's clipping; trackpad force-click.

### R5: undo, progress, shortcuts, update-refs, verification

- **Scope:** the undo record and walk rules (§6), `progress` events + banner text, graph menu
  shortcuts (Reword… / Drop… / Squash into parent…) built on `rebaseInteractive`, opt-in
  `--update-refs` (a checkbox in the editor: "Also move stacked branches (feat/b, feat/c)"),
  "Stash & Undo", and a smoke-harness verification run with the screenshots in §5.9.
- **Acceptance:** §9.3 undo rows pass; undo is offered after every app rebase/merge and after a
  terminal rebase; an aborted rebase no longer blocks undo; the verification table is filled with
  Pass rows and the screenshots were looked at.
- **Size:** ~6 touched; ~700 code + ~1.1k tests + the verification doc.
- **Risks:** walk-rule regressions in existing undo (keep every current `undo.test.js` case green;
  add the old-reflog fixtures); the record refs piling up (the same TODO as discard backups:
  pruning).

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| Rebasing published branches hurts teammates | The warning before, lease-only force push after, undo, the published count in the editor header; Q3 for stricter rules |
| No conflict editor: users with many conflicts must use an external editor | Keep-a-side per file, the read-only conflict diff, clear banner text; recommend a conflict-editor project next (§13) |
| The editor helper on Windows: Git for Windows runs the editor through its MSYS `sh`; `process.execPath` has backslashes and maybe spaces | Paths travel only through env vars inside double quotes (no quoting of our own); git passes `$1` as `C:/…/git-rebase-todo`, which Node reads fine; MSYS path conversion doesn't apply to env values or to a non-MSYS program's argv. Needs a real Windows CI run before R3 ships there (Q8) |
| Packaged app: the helper inside `app.asar` | Electron-as-Node can require from asar, but mark `src/rebase-editor.js` as `asarUnpack` when packaging lands (packaging is not built yet) |
| A hook or signing prompt hangs a rebase | Soft cancel (SIGTERM) → stopped rebase → Abort; the banner explains |
| User config changes rebase behaviour | Explicit flags and `-c` overrides (§3.1), and every test under the extended `hostileConfig` |
| Internal files of git (`rebase-merge/*`) change format | Read defensively (caps, OID checks, `stop: 'other'` fallback); only `done`, `git-rebase-todo`, `head-name`, `onto`, `orig-head`, `msgnum`, `end`, `amend`, `stopped-sha`, `message` are used, all stable since git 2.26; the min git is 2.51 |
| `--empty=drop` hides a commit a user expected to see | The notice lists dropped commits, and undo can bring everything back |
| Undo moves the worktree | Only with a clean tree, via a two-tree `read-tree -m -u` that refuses to overwrite; redo mirrors it |

---

## 12. Open questions for the user

1. **Merge first?** The recommendation is R1 → merge (R2 first half) → rebase menus. OK, or do you
   want rebase from menus before merge?
2. **Force push after a rebase of pushed commits:** offer it right away in a follow-up dialog
   (recommended, default "Later"), or only when the next push is rejected?
3. **Published / protected branches:** warn only (recommended), or refuse rebasing `main` /
   `master` / the remote's default branch unless a setting allows it? Do you want a configurable
   protected-branch list?
4. **Conflict editor:** OK to keep it out of scope, with Keep-a-side + Mark resolved + the
   read-only conflict diff? Would an "Open in external merge tool" (`git mergetool`-style,
   configured tool) be welcome in R2, or should the conflict editor be the next project?
5. **`git replay` for rebasing a branch that isn't checked out, without a checkout:** worth an
   experimental fast path later, or stay with checkout-first only?
6. **`#` lines in rebased messages** are removed (`commit.cleanup=strip`), unlike the app's normal
   commits. Acceptable, or should reword keep them (more complex: the helper would have to strip
   git's own comments itself)?
7. **`fixup` and `edit`:** keep them in the interactive editor (recommended; cheap), or offer only
   pick / reword / squash / drop?
8. **Windows:** is Windows a target for R3, and is there a Windows machine or CI for the helper
   tests?
9. **Alt-drop semantics:** "Alt at drop opens the interactive editor directly": is that the
   behaviour you have in mind?
10. **Cancel during a running rebase** leaves a stopped rebase (then Abort). Acceptable, or should
    Cancel also abort automatically (cleaner, but loses conflict work done in a hook-stopped
    reword)? (The other half of this question, adding `sequence.editor` / `core.editor` to the
    untrusted-config keys, is done: both are in `RISKY_CONFIG`.)
11. **Skip hooks:** do you want a skip-hooks checkbox for rebases (the
    roadmap has one for commits as Later)?

---

## 13. Out of scope / later

Conflict (3-way) editor and external merge-tool launch; `--rebase-merges`; `--root` rebases;
interactive cherry-pick; squash merge; multi-select in the graph (Squash/Drop N commits);
`rebase --quit`; "Skip hooks"; `git replay` fast path; autosquash from `fixup!` subjects; AI
recompose; pruning `refs/pasta-lite/rebases/*` and backup refs.
