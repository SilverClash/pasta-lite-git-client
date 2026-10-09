'use strict';
// Redaction for log records. Pure, no dependencies: src/log.js runs redact() on every
// record, and main runs it again on what the renderer forwards (app:log).
//
// What is removed or masked:
// - private-key blocks (-----BEGIN ... PRIVATE KEY----- ... END, or to the end when cut off);
// - credentials in URLs: scheme://user:token@host (any userinfo) -> scheme://***@host, anywhere
//   in a string, so git's stderr ("fatal: unable to access 'https://x:y@host/'") is covered;
// - Authorization headers ("Authorization: Basic xyz"), "Bearer <token>", token= / password= /
//   secret= / api_key= style assignments, and NAME=value where NAME looks like a secret
//   (TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL);
// - GitHub / GitLab / AWS token shapes (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_, glpat-, AKIA...);
// - object fields whose key looks like a secret (SECRET_KEY: the same names plus AUTHORIZATION and
//   COOKIE): their whole value;
// - fields that could hold repo contents (input, stdin, stdout, stderr, content(s), diff, patch,
//   blob, commitMessage): never kept;
// - the home directory: replaced with '~' (paths still say which repo, not whose account).
// Strings are capped (MAX_STRING), stacks to MAX_STACK_LINES, arrays / objects / depth bounded.
const os = require('node:os');

const MASK = '***';
const MAX_STRING = 4000;
const MAX_STACK_LINES = 12;
const MAX_ITEMS = 50;
const MAX_DEPTH = 6;

/** Keys (object fields, env names) whose values are secrets. */
const SECRET_KEY = /TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL|AUTHORIZATION|COOKIE/i;
/** Fields that could carry repository contents: dropped whatever they hold. */
const CONTENT_KEYS = new Set(['input', 'stdin', 'stdout', 'stderr', 'content', 'contents', 'diff', 'patch', 'blob', 'commitmessage']);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Order matters: key blocks first (they contain '=' and '+' that later rules would chew on),
// then URL userinfo, headers, assignments and bare token shapes.
const RULES = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, '[private key redacted]'],
  // scheme://userinfo@ -> scheme://***@ (userinfo: anything up to '@' without '/', whitespace or quotes).
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@'"<>]+@/gi, `$1${MASK}@`],
  [/\b(authorization|proxy-authorization)(\s*[:=]\s*)(?:(basic|bearer|token|digest|negotiate)\s+)?[^\s'",;]+/gi,
    (_m, k, sep, scheme) => `${k}${sep}${scheme ? `${scheme} ` : ''}${MASK}`],
  [/\bbearer\s+[a-z0-9._~+/=-]{8,}/gi, `Bearer ${MASK}`],
  [/\b(github_pat_\w{20,}|gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16})\b/g, MASK],
  // token=..., password: ..., secret="...", api_key=... (any case, the name may be longer:
  // x-access-token=, db_password:).
  [/\b([\w.-]*(?:token|password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[\w.-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&"',;)]+)/gi, // NOSONAR(S5843): one alternation of secret names, covered by test/redact.test.js
    `$1$2${MASK}`],
  // Env style: SOME_NAME=value where the upper-case name contains TOKEN / SECRET / PASSWORD / KEY /
  // CREDENTIAL (AWS_SECRET_ACCESS_KEY=, NPM_TOKEN=, SSH_KEY=).
  [/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL)[A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g, `$1=${MASK}`],
];

let HOME = null;
let homeRe = null;

// A Windows home matches in any case (git may print C:/users/ada for C:\Users\Ada), folded as
// src/fs-paths.js folds a path: ASCII letters only. The regex `i` flag would fold more (U+212A
// KELVIN SIGN is 'k' to it), and a folder Windows calls another one would be logged as the home.
// A class per letter after escaping: escapeRe never leaves a letter after a backslash.
const asciiCaseless = (re) => re.replace(/[A-Za-z]/g, (c) => `[${c.toUpperCase()}${c.toLowerCase()}]`);

/**
 * The home directory to replace with '~' (default os.homedir()); '' disables. For tests. On
 * Windows (`platform`) in any ASCII case and with '/' or '\\' (or JSON's '\\\\').
 */
function setHome(dir, { platform = process.platform } = {}) {
  HOME = dir === undefined ? safeHome() : dir;
  homeRe = null;
  if (HOME && HOME.length > 1) {
    const forms = new Set([HOME, HOME.replace(/\\/g, '/'), HOME.replace(/\\/g, '\\\\')]);
    const fold = platform === 'win32' ? asciiCaseless : (re) => re;
    // Only at a path boundary: /Users/ada must not eat /Users/adam.
    homeRe = new RegExp(`(${[...forms].map((f) => fold(escapeRe(f))).join('|')})(?=$|[\\\\/'"\\s:)\\]])`, 'g');
  }
}
function safeHome() {
  try { return os.homedir(); } catch { return ''; }
}
setHome();

/** Redact one string (all rules, home dir, length cap). */
function redactString(s, max = MAX_STRING) {
  let out = String(s);
  for (const [re, rep] of RULES) out = out.replace(re, rep); // NOSONAR(S3782): `rep` is a replacement string or function, both valid
  if (homeRe) out = out.replace(homeRe, '~');
  if (out.length > max) out = `${out.slice(0, max)}…[+${out.length - max} chars]`;
  return out;
}

/** A stack trace: redacted and cut to MAX_STACK_LINES lines. */
function redactStack(stack) {
  if (typeof stack !== 'string' || !stack) return undefined;
  const lines = stack.split('\n');
  const kept = lines.slice(0, MAX_STACK_LINES);
  if (lines.length > kept.length) kept.push(`    … ${lines.length - kept.length} more`);
  return redactString(kept.join('\n'), MAX_STRING * 2);
}

// ---------------------------------------------------------------- git argv

// '-c name=value' pairs git-process.js prepends (and any other -c the caller passes): the config
// overrides say nothing about what went wrong and would drown the command.
const MESSAGE_FLAGS = new Set(['-m', '--message', '-F', '--file', '--reason']);

/**
 * A git argv safe to log: leading `-c key=value` overrides dropped, message values (-m, --message,
 * -F, `reflog write`'s message, `commit-tree -m`) replaced with '<message>', everything after
 * '--' (pathspecs) replaced by a count, long arguments cut. Paths before '--' (rare: none of our
 * commands put file paths there) still go through redactString when the record is written.
 */
function summarizeArgs(args) {
  if (!Array.isArray(args)) return [];
  const a = args.map(String);
  let i = 0;
  while (a[i] === '-c' && i + 1 < a.length) i += 2;
  const out = [];
  for (; i < a.length; i++) {
    const x = a[i];
    if (x === '--') {
      const n = a.length - i - 1;
      out.push('--', `<${n} path${n === 1 ? '' : 's'}>`);
      break;
    }
    if (MESSAGE_FLAGS.has(x)) {
      out.push(x, '<message>');
      i++;
      continue;
    }
    const eq = /^(--message|--file|--reason)=/.exec(x);
    if (eq) {
      out.push(`${eq[1]}=<message>`);
      continue;
    }
    out.push(x.length > 200 ? `${x.slice(0, 200)}…` : x);
  }
  // `git reflog write <ref> <old> <new> <message>`: the message is positional.
  if (out[0] === 'reflog' && out[1] === 'write' && out.length >= 6) out.splice(5, out.length - 5, '<message>');
  return out;
}

// ---------------------------------------------------------------- values

/** A plain, redacted copy of an Error: {name, kind, code, exitCode, message, argv?, stack}. */
function redactError(err, depth = 0) {
  const o = { name: typeof err.name === 'string' ? err.name : 'Error' };
  if (typeof err.kind === 'string') o.kind = err.kind;
  if (err.code !== undefined && err.code !== null) o.code = String(err.code);
  if (Number.isInteger(err.exitCode)) o.exitCode = err.exitCode;
  o.message = redactString(typeof err.message === 'string' ? err.message : String(err));
  // A GitError's argv (never its raw stdout / stderr: the message already is git's stderr).
  if (Array.isArray(err.args)) o.argv = summarizeArgs(err.args).map((x) => redactString(x, 300));
  const stack = redactStack(err.stack);
  if (stack) o.stack = stack;
  if (err.cause && depth < 2) o.cause = err.cause instanceof Error ? redactError(err.cause, depth + 1) : redact(err.cause, depth + 1);
  return o;
}

const isErrorLike = (v) => v instanceof Error || (v && typeof v === 'object' && typeof v.message === 'string' && typeof v.stack === 'string');

/**
 * Deep, plain, redacted copy of `value` for a log record. Never throws; never returns functions,
 * symbols, Buffers or cycles (they become short descriptions).
 */
function redact(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case 'string': return redactString(value);
    case 'number': return Number.isFinite(value) ? value : String(value);
    case 'boolean': return value;
    case 'bigint': return String(value);
    case 'function': return '[function]';
    case 'symbol': return '[symbol]';
    default: break;
  }
  try {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (isErrorLike(value)) return redactError(value, depth);
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return `[${value.byteLength} bytes]`;
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : 'Invalid Date';
    if (depth >= MAX_DEPTH) return '[…]';
    if (Array.isArray(value) || value instanceof Set) {
      const list = [...value];
      const out = list.slice(0, MAX_ITEMS).map((x) => redact(x, depth + 1, seen));
      if (list.length > MAX_ITEMS) out.push(`…[+${list.length - MAX_ITEMS} items]`);
      return out;
    }
    const entries = value instanceof Map ? [...value.entries()].map(([k, v]) => [String(k), v]) : Object.entries(value);
    const out = {};
    let n = 0;
    for (const [k, v] of entries) {
      if (n++ >= MAX_ITEMS) {
        out['…'] = `+${entries.length - MAX_ITEMS} keys`;
        break;
      }
      if (CONTENT_KEYS.has(k.toLowerCase())) {
        out[k] = '[omitted]';
      } else if (SECRET_KEY.test(k) && v !== null && v !== undefined && v !== '') {
        out[k] = MASK;
      } else {
        out[k] = redact(v, depth + 1, seen);
      }
    }
    return out;
  } catch {
    return '[unserializable]';
  }
}

/** Env-style map with every secret-looking name masked (for diagnostics; values of others redacted). */
function redactEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) out[k] = SECRET_KEY.test(k) ? MASK : redactString(v, 500);
  return out;
}

module.exports = {
  redact, redactString, redactError, summarizeArgs,
  _internal: { redactEnv, setHome, MAX_STRING }, // exported for unit tests only
};
