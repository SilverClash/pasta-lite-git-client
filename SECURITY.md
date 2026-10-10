# Security policy

## Supported versions

Pasta Lite is alpha software. Releases are distributed as DMGs for macOS, signed with a Developer
ID and notarized by Apple, on the repository's
[GitHub Releases page](https://github.com/SilverClash/pasta-lite-git-client/releases); it also runs
from source. Only the latest 0.2.x release (and the code on `main`) gets security fixes.

| Version | Supported |
| ------- | --------- |
| 0.2.x   | Yes       |
| < 0.2   | No        |

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private vulnerability reporting: open the
repository's **Security** tab and click **Report a vulnerability**. Do not open a public issue, pull
request or discussion for a security problem.

There is no security email address. All reports go through GitHub.

### What to include

- What an attacker can do, and what they need first (for example "the victim opens a folder I
  sent them").
- Steps to reproduce: a minimal repository or a script that builds one, and the exact actions in
  the app.
- The Pasta Lite version (Help → Copy Diagnostics), or the commit (`git rev-parse HEAD`) when you
  run it from source, your OS and version, and `git --version`.
- Logs or a proof of concept if you have one. Help → Copy Diagnostics collects versions and recent
  log lines with credentials and the home folder redacted. Check it before you attach it.
- Whether you want to be credited in the advisory, and under what name.

### What to expect

- We acknowledge your report within **7 days**.
- We tell you whether we accept the issue as a vulnerability, and our plan for it, within
  **30 days** of the acknowledgement.
- We fix it in a private fork and publish a GitHub security advisory when the fix lands on
  `main`. We credit you unless you ask us not to.

This is a small volunteer project, so these are targets rather than guarantees. If you hear
nothing within 7 days, add a comment to your report.

## Scope

Pasta Lite runs the `git` CLI on repositories that can come from anywhere: a clone, a download or a
folder someone sent you. Git itself can run programs that a repository's own configuration names.
Reports about these areas are especially welcome.

**Repositories that run commands.** Before it opens a repository, the app checks the repository's
own git config for settings that run programs, such as filter drivers, `core.sshCommand`,
`core.hooksPath`, `core.editor`, credential helpers and merge or diff tools, and for any
`include.path` or `includeIf` (an include can bring such settings in later, after a checkout). It
also checks the hooks folder of every repository, bare or with a working tree, for hooks git would
run (following `core.hooksPath`; a linked worktree reports the main repository's hooks), and the
same config and hooks of every submodule and the config git reads in each of the repository's other
worktrees. If it finds any, it shows a **Trust and Open** prompt that defaults to Cancel. The app
always runs git with `core.fsmonitor=false` and `protocol.ext.allow=never`, so the `ext::` transport
(which runs its URL as a shell command) is always blocked, whatever the repository's config says.
It keeps git out of submodules wherever a flag can (status, diffs, checkout, fetch and push). It
never opens an editor or terminal prompt, and passes on only an allowlisted set of `GIT_*`
environment variables. It never continues or skips a rebase whose remaining steps run commands
(`exec` lines), whoever started it: only Abort is offered.
Examples of vulnerabilities in this area:

- a way for a repository's config or hooks to run a command without the prompt
- a way to get past the prompt, or to reuse a trust decision for a different repository or
  different settings

**Electron sandboxing.** Every page (the tab strip and each tab) runs with `contextIsolation`,
`sandbox` and `webSecurity` on, with `nodeIntegration` off, and with a strict Content Security
Policy. The packaged app has its Electron fuses set: it can't be run as plain Node
(`ELECTRON_RUN_AS_NODE`), ignores `NODE_OPTIONS` and the `--inspect` flags, loads its code only from
its `app.asar`, and checks that archive against the hash embedded in the signed app. The pages reach the main process only through the preload bridges. The main process
accepts only the IPC channels and operations on its allowlist (`src/ipc-contract.js`,
`src/ops.js`). It checks which page sent each call and supplies that tab's repository itself, so
the renderer never passes a repository path. Examples of vulnerabilities in this area:

- script injection from git-derived text: branch names, commit messages, file names or diffs
- escaping the sandbox, or reaching a channel or operation that is not on the allowlist
- making an operation act on a repository or path other than the tab's own

**Cloning.** Clone Repository… accepts typed `https`, `http`, `ssh` (and scp-like `user@host:path`)
and `git` URLs only. It never runs a transport helper (`ext::`, `fd::` or any `<helper>::` URL,
and git's own `protocol.allow=never` with those four transports allowed on the command line, so a
`url.<x>.insteadOf` can't rewrite a URL into one), and it clones from remotes only: a local path,
`file://` URL, UNC or device path is refused, so a page can't make the app clone, then open and
read, a private repository on your machine, or make Windows send your credentials to a share it
names. A host must be a plain host name or IP address, and a user name can't start with `-`, so
nothing in a URL reaches ssh as an option or as shell syntax (such as a ProxyCommand's `%h`). URLs with a password, an access token
as the user name, or (for `https`) a query string are refused, because git would save them in
the repository's settings. git's file transport is never allowed, and git runs in the new,
empty target folder, so an scp-like `host:path` can't name a local folder either. The page only
chooses the folder name (one path segment, never starting with a dot, never with ':') and echoes
the parent folder main showed it; there is no default parent, so nothing lands in the home folder
(say in `~/.config`, where a clone's `git/config` would become the global git config) unless the
user picked it. The cleanup of a failed clone removes only the folder the app created, only with
evidence that its clone failed, and never one the recent list or a tab names. Two things are by
design:

- a page can choose the network host a clone contacts (that is what cloning is). Everywhere else a
  page can only make git contact remotes already in a repository's config. This matters only once
  a page is compromised, and the four transports above are all it can use.
- Git LFS, when you installed it globally, follows a repository's committed `.lfsconfig`: its
  checkout can download, with the credentials your helper gives that host, from a server the
  repository names. A clone from a terminal does the same.

Examples of vulnerabilities in this area: a way to make a clone run a program, clone a local
repository, write outside the folder it creates, delete anything but a
folder the app created for a clone that failed, or keep a secret from the URL in a log.

**Local data.** Logs and crash reports stay on your machine (Help → Show Logs). Credentials, tokens
and the home folder are redacted from them. A secret that ends up in a log or in Copy Diagnostics
is in scope.

**Out of scope:**

- vulnerabilities in git, Electron or Chromium themselves (report them upstream), unless Pasta
  Lite makes them reachable in a way they otherwise are not
- actions you confirmed in the app: after you choose **Trust and Open**, the repository's
  configured programs run, which is what that button means
- attacks that need an attacker who can already run code as your user, or write to your git
  config or the app's data folder
- the development-only `--smoke` harness, which a packaged build never enables
