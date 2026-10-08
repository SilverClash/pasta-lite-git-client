'use strict';
// The editor git runs during our rebases (docs/plans/rebase.md §3.3): two constant shell commands
// that copy what the backend prepared into the file git opens. src/rebase.js sets
//   GIT_SEQUENCE_EDITOR=TODO_EDITOR   GIT_EDITOR=MSG_EDITOR   PL_GIT_DIR=<absolute git dir>
// and git runs `sh -c '<command> "$@"' <command> <file>` (git's own sh on Windows too), so the
// function gets the role and the file. The command strings are constants: the only data is
// PL_GIT_DIR, from the environment; the state folder is always <git-dir>/pasta-lite/rebase.
// No program of the app's runs: the packaged app can't run as plain Node (its runAsNode fuse is
// off), and needs no interpreter of its own here.
//
//   todo <file>  <file> must be <git-dir>/rebase-merge/git-rebase-todo (the same file, neither
//                it nor rebase-merge/ a symlink). It is replaced by $STATE/todo, which the backend
//                wrote from validated {cmd, sha} pairs; every line is checked against the same
//                allow-list again (no exec, break, label, reset, merge, ever). Exit 1 (git then
//                starts nothing) on any doubt.
//   msg <file>   <file> must be <git-dir>/COMMIT_EDITMSG (also for a squash group's final message:
//                git runs `commit -F rebase-merge/message-squash -e`, which edits COMMIT_EDITMSG;
//                verified with git 2.51). The command git is completing is the last line of
//                <git-dir>/rebase-merge/done ("reword <sha>", a squash group's last
//                "squash"/"fixup", the conflicted "pick"); if $STATE/msgs/<sha> exists it is
//                written to <file>, otherwise git's text is left alone (exit 0).
//
// The state folder, <git-dir>/pasta-lite and every prepared file must be plain (no symlink). git
// passes the file's real path; it is checked to be the very file named above (`-ef`) before it
// is written, and the shell writes through no symlink it was given. It prints no paths or
// messages (git copies its stderr into errors the app may log); a refusal prints
// namespace.HELPER_REFUSED. Uses sh, cat, grep and awk only (all in git's own sh environment).
const { PL_DIR, REBASE_DIR, HELPER_REFUSED } = require('./namespace');

// Git for Windows' grep reads files as text (CR LF becomes LF), so a todo line ending in CR passed
// the check; it would check other bytes than the ones cat copies and git reads. -U makes it read
// the bytes as they are. Elsewhere plain grep (BSD grep's -U, on macOS, changes what -v matches).
const GREP = process.platform === 'win32' ? 'grep -U' : 'grep';

/** Commands the backend may put in a todo (TODO_ACTIONS of src/rebase.js). */
const TODO_CMDS = Object.freeze(['pick', 'reword', 'edit', 'squash', 'fixup', 'drop']);
const MAX_TODO_LINES = 10000;
const TODO_LINE = new RegExp(`^(${TODO_CMDS.join('|')}) ([0-9a-f]{40}|[0-9a-f]{64})$`);

/** True when `text` is a todo the backend could have written: allow-listed lines only (what the todo role checks again). */
function validTodo(text) {
  if (typeof text !== 'string' || !text.endsWith('\n')) return false;
  const lines = text.slice(0, -1).split('\n');
  return lines.length > 0 && lines.length <= MAX_TODO_LINES && lines.every((l) => TODO_LINE.test(l));
}

// The shell function both roles share. `$d`: the git dir (absolute: '/...' or, on Windows,
// 'C:/...'); `$s`: the state folder, or empty when it isn't a plain folder.
const SCRIPT = [
  `pl_no() { echo '${HELPER_REFUSED}: '"$1" >&2; exit 1; }`,
  'pl_plain() { [ -f "$1" ] && [ ! -L "$1" ]; }',
  'pl_edit() {',
  '  [ $# -eq 2 ] || pl_no usage',
  '  d=$PL_GIT_DIR',
  '  case $d in /*|[A-Za-z]:/*) ;; *) pl_no "no git dir" ;; esac',
  `  s=$d/${PL_DIR}/${REBASE_DIR}`,
  `  { [ -d "$d/${PL_DIR}" ] && [ ! -L "$d/${PL_DIR}" ] && [ -d "$s" ] && [ ! -L "$s" ]; } || s=`,
  '  case $1 in',
  '  todo)',
  '    t=$d/rebase-merge/git-rebase-todo',
  '    { pl_plain "$t" && [ ! -L "$d/rebase-merge" ] && [ "$2" -ef "$t" ]; } || pl_no "not the rebase todo file"',
  '    [ -n "$s" ] && pl_plain "$s/todo" && [ -s "$s/todo" ] || pl_no "no todo was prepared"',
  // grep -v exits 1 only when every line is allowed (0: a line isn't, 2: it couldn't read).
  `    ${GREP} -Evq '^(${TODO_CMDS.join('|')}) ([0-9a-f]{40}|[0-9a-f]{64})$' "$s/todo"`,
  '    [ $? -eq 1 ] || pl_no "the prepared todo has an unsupported line"',
  '    cat -- "$s/todo" > "$t" ;;',
  '  msg)',
  '    t=$d/COMMIT_EDITMSG',
  '    { pl_plain "$t" && [ "$2" -ef "$t" ]; } || pl_no "not the commit message file"',
  '    [ -n "$s" ] && [ -d "$s/msgs" ] && [ ! -L "$s/msgs" ] || return 0',
  '    h=$(awk \'!/^[ \\t]*#/ && NF { c = $2 } END { print c }\' "$d/rebase-merge/done" 2>/dev/null)',
  "    case $h in ''|*[!0-9a-f]*) return 0 ;; esac",
  '    [ ${#h} -eq 40 ] || [ ${#h} -eq 64 ] || return 0',
  '    pl_plain "$s/msgs/$h" || return 0',
  '    cat -- "$s/msgs/$h" > "$t" ;;',
  '  *) pl_no "unknown role" ;;',
  '  esac',
  '}',
].join('\n');

/** GIT_SEQUENCE_EDITOR of an interactive rebase we start (git appends ` "$@"`: the todo file). */
const TODO_EDITOR = `${SCRIPT}\npl_edit todo`;
/** GIT_EDITOR of our rebase commands (git appends ` "$@"`: COMMIT_EDITMSG). */
const MSG_EDITOR = `${SCRIPT}\npl_edit msg`;

module.exports = { TODO_CMDS, validTodo, TODO_EDITOR, MSG_EDITOR };
