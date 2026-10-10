/*
 * Pasta Lite - the source and the folder name of a clone (docs/plans/clone-repository.md §5.1):
 * which typed URLs may reach `git clone`, the folder name git would derive from a source, and the
 * one-segment folder names main accepts.
 *
 * Pure. Works in Node (`require('./src/clone-url.js')`) and in the browser as a plain <script>
 * (exposes `window.PLCloneUrl`; index.html loads src/display-text.js and src/path-names.js before
 * it), like src/error-kinds.js. The page checks as the user types; main checks again before git
 * runs (src/clone.js, src/ops.js cloneCheck): the page's answer is a convenience only.
 *
 * parseCloneUrl(text) -> {ok: true, url, kind, host, user, path, display, notes}
 *   | {ok: false, reason}. A typed network URL only: https, http, ssh://, scp-like user@host:path
 *   or git://. A local path, a file: URL (any host), a UNC or device path and a drive path are
 *   refused on every platform (the page can't be trusted to name its platform): the app clones
 *   from remotes only. So are git's remote helpers (`<x>::`, other schemes),
 *   a password or a token-shaped user name, and for http(s) a '?' or '#' (git would store the URL
 *   as typed in .git/config). `notes`: 'insecure' (http, git), 'user-in-url'.
 * deriveName(source, {platform}) -> the folder name git would derive ('' when none is usable).
 * nameError(name, {platform}) -> the message for a refused folder name, or null.
 * deriveName and nameError take `{platform}`: process.platform under Node by default; the
 * renderer passes window.api.platform.
 */
(function (exports, DisplayText, PathNames) {
  'use strict';

  const MAX_URL = 2048;
  const MAX_NAME_BYTES = 255;
  const { INVISIBLE, JOINERS, hasInvisible } = DisplayText;
  const { isDotGitName, DEVICE_NAME, WIN_INVALID_CHARS, defaultPlatform } = PathNames;

  const LOCAL = 'Enter a remote URL (https://…, ssh://…, git@host:…): a local path or file:// URL isn\'t cloned here';
  const refuse = (reason) => ({ ok: false, reason });

  const SCHEMES = new Set(['https', 'http', 'ssh', 'git']);
  const INSECURE = new Set(['http', 'git']);
  // A host name (letters, digits, dots and hyphens, starting and ending with a letter or a digit:
  // IDN names too), an IPv4 address or a bracketed IPv6 one. Nothing a shell would read: ssh puts
  // the host into a ProxyCommand's %h as it is (CVE-2023-51385), so ssh://h$(id)/r must not pass.
  const HOST = /^(?:\[[0-9A-Fa-f:.]+\]|[\p{L}\p{N}](?:[\p{L}\p{N}.-]*[\p{L}\p{N}])?)$/u;
  // A user name: never an option ('-oProxyCommand@h' would reach ssh as one).
  const USER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,38}$/;
  const MAX_PORT = 65535;
  // An scp-like URL whose "host" is a scheme: https:/github.com/o/r or https:github.com/o/r.
  const SCHEME_AS_HOST = /^(?:https?|ssh|git|file)$/i;
  // Known token prefixes (the shapes src/redact.js masks, and a few more hosts'), or a long run of
  // letters and digits that mixes both (what a generated token looks like, not a person's name).
  const TOKEN_PREFIX = /^(?:github_pat_|gh[pousr]_|glpat-|glptt-|hf_|npm_|pypi-|xox[abpr]-|(?:AKIA|ASIA)[0-9A-Z]{12})/;
  const tokenShaped = (u) => TOKEN_PREFIX.test(u) || (/^[A-Za-z0-9]{24,}$/.test(u) && /[A-Za-z]/.test(u) && /\d/.test(u));

  /** The refusal of a URL's userinfo (the part before '@'), or null when the user name may stay. */
  function userError(userinfo) {
    if (userinfo.includes(':')) return 'Remove the password from the URL: git would keep it in plain text in the repository\'s settings. A credential helper stores it safely';
    if (tokenShaped(userinfo)) return 'The user name looks like an access token: git would keep it in plain text in the repository\'s settings. Remove it and let a credential helper sign in';
    if (!USER.test(userinfo)) return 'This user name can\'t be used in a URL here: remove it and let a credential helper sign in';
    return null;
  }

  const hostError = (host) => {
    if (!host) return 'The URL has no host';
    if (host.startsWith('-')) return 'A host name can\'t start with "-"';
    return HOST.test(host) ? null : 'The host name isn\'t valid';
  };

  /** An accepted URL with its notes (`user`: null or the user name). */
  function accepted(url, kind, host, user, path) {
    const notes = [];
    if (INSECURE.has(kind)) notes.push('insecure');
    if (user && !(user === 'git' && (kind === 'ssh' || kind === 'scp'))) notes.push('user-in-url');
    return { ok: true, url, kind, host, user, path, display: url, notes };
  }

  /** `scheme://[user@]host[:port][/path]` of a scheme in SCHEMES. */
  function parseSchemeUrl(url, scheme, rest) {
    if ((scheme === 'https' || scheme === 'http') && /[?#]/.test(url)) {
      return refuse('Remove the "?…" or "#…" part: it can carry a token, and git would keep it in the repository\'s settings');
    }
    const slash = rest.search(/[/\\]/);
    const authority = slash < 0 ? rest : rest.slice(0, slash);
    const path = slash < 0 ? '' : rest.slice(slash);
    if (path.includes('\\')) return refuse('Use "/" in a URL, not "\\"');
    const at = authority.lastIndexOf('@');
    const user = at < 0 ? null : authority.slice(0, at);
    if (user !== null) {
      const why = userError(user);
      if (why) return refuse(why);
    }
    const hostPort = at < 0 ? authority : authority.slice(at + 1);
    const m = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/.exec(hostPort);
    if (!m) return refuse('The host name isn\'t valid');
    const [, host, port] = m;
    const why = hostError(host);
    if (why) return refuse(why);
    if (port !== undefined && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > MAX_PORT)) return refuse('The port isn\'t valid');
    return accepted(url, scheme, host, user, path);
  }

  /** scp-like `[user@]host:path`, split into its parts (user null when there is none). */
  function parseScpLike(url, user, host, path) {
    if (SCHEME_AS_HOST.test(host)) return refuse(`Did you mean ${host.toLowerCase()}://…? A URL needs "://" after its scheme`);
    if (user !== null) {
      const why = userError(user);
      if (why) return refuse(why);
    }
    const why = hostError(host);
    if (why) return refuse(why);
    // A one-letter "host" is a drive letter (C:repo, refused above as a local path).
    if (host.length < 2) return refuse(user === null ? LOCAL : 'The host name is too short');
    if (!path) return refuse('The URL has no repository path after ":"');
    if (path.startsWith('-')) return refuse('A repository path can\'t start with "-"');
    return accepted(url, 'scp', host, user, path);
  }

  /**
   * Classify and validate a typed source (see the header). Only trimmed: nothing else is changed,
   * and an accepted `url` is what git gets. The same on every platform, so it takes none: a
   * Windows path is refused on macOS too.
   */
  function parseCloneUrl(text) {
    const url = String(text == null ? '' : text).trim();
    if (!url) return refuse('Enter a repository URL');
    if (url.length > MAX_URL) return refuse(`The URL is longer than ${MAX_URL} characters`);
    if (hasInvisible(url, { joiners: true })) return refuse('The URL contains invisible or control characters');
    if (url.startsWith('-')) return refuse('A URL can\'t start with "-"');
    // Local sources, whatever the platform: file: URLs, absolute, home-relative and relative
    // paths, drive paths (C:\x, C:/x, drive-relative C:x), UNC and device paths (\\x, //x, \\?\, \\.\).
    if (/^file:/i.test(url) || /^[/\\~]/.test(url) || /^[A-Za-z]:/.test(url) || /^\.\.?(?:[/\\]|$)/.test(url)) return refuse(LOCAL);
    // git's remote-helper syntax runs a program (git-remote-<x>; ext:: runs a shell command).
    if (/^[A-Za-z0-9][A-Za-z0-9+.-]*::/.test(url)) return refuse('This kind of URL runs a helper program: clone it from a terminal');
    const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url);
    if (scheme) {
      const name = scheme[1].toLowerCase();
      if (!SCHEMES.has(name)) return refuse(`${scheme[1]}:// URLs aren't supported: use https, ssh or git`);
      // git matches protocol.<name>.allow in lower case only: HTTPS:// would be refused as a transport.
      return parseSchemeUrl(`${name}${url.slice(name.length)}`, name, url.slice(scheme[0].length));
    }
    // scp-like with a bracketed host, as git takes it: [user@][::1]:path.
    const bracketed = /^(?:([^@/\\[\]]*)@)?(\[[^\]/\\]*\]):(.*)$/s.exec(url);
    if (bracketed) return parseScpLike(url, bracketed[1] === undefined ? null : bracketed[1], bracketed[2], bracketed[3]);
    // scp-like: a ':' before any '/' (git's own rule). No ':' at all is a relative path.
    const colon = url.indexOf(':');
    const slash = url.search(/[/\\]/);
    if (colon < 0) return refuse(LOCAL);
    if (slash >= 0 && slash < colon) return refuse(LOCAL);
    const left = url.slice(0, colon);
    const at = left.lastIndexOf('@');
    return parseScpLike(url, at < 0 ? null : left.slice(0, at), at < 0 ? left : left.slice(at + 1), url.slice(colon + 1));
  }

  const isSep = (c) => c === '/' || c === '\\';

  /**
   * The folder name `git clone` would derive from `source` (git's git_url_basename, with '\\' a
   * separator too): skip the scheme and the user, drop trailing separators and a '/.git', a bare
   * host's port, everything up to the last separator or ':', then a '.git' or '.bundle'. No
   * decoding ('a%20b' stays). Then cleaned: invisible characters and leading dots removed (no
   * '.config', '.ssh' ...), and on Windows its invalid characters made '-' and trailing dots and
   * spaces dropped. '' when no valid name (nameError) is left: the dialog asks for one.
   */
  function deriveName(source, { platform = defaultPlatform() } = {}) {
    let s = String(source == null ? '' : source).trim();
    const scheme = s.indexOf('://');
    if (scheme >= 0) s = s.slice(scheme + 3);
    const host = s.indexOf('/') < 0 ? s : s.slice(0, s.indexOf('/'));
    if (host.includes('@')) s = s.slice(host.lastIndexOf('@') + 1); // the user, up to the last '@' before any '/'
    let end = s.length;
    while (end > 0 && (isSep(s[end - 1]) || /\s/.test(s[end - 1]))) end--;
    if (end > 5 && isSep(s[end - 5]) && s.slice(end - 4, end) === '.git') {
      end -= 5;
      while (end > 0 && isSep(s[end - 1])) end--;
    }
    s = s.slice(0, end);
    if (!/[/\\]/.test(s) && s.includes(':')) s = s.replace(/:\d*$/, ''); // a bare host's port
    const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'), s.lastIndexOf(':'));
    s = s.slice(cut + 1).replace(/\.(?:git|bundle)$/, '');
    s = s.replace(INVISIBLE, '').replace(JOINERS, '').replace(/^\.+/, '');
    if (platform === 'win32') s = s.replace(new RegExp(WIN_INVALID_CHARS.source, 'g'), '-').replace(/[. ]+$/, '');
    return nameError(s, { platform }) ? '' : s;
  }

  /** UTF-8 length of `s` (TextEncoder: in Node and in the page). */
  const utf8Length = (s) => new TextEncoder().encode(s).length;

  /**
   * Why `name` can't be the folder a clone creates (one segment), or null. The rules main enforces.
   * On every platform: no leading dot (a clone into ~/.config would make its git/config the user's
   * global git config, into ~/.ssh their ssh setup) and no ':' (git takes an scp-like
   * "host:path" that exists as a local folder for one).
   */
  function nameError(name, { platform = defaultPlatform() } = {}) {
    const n = String(name == null ? '' : name);
    if (!n.trim()) return 'Enter a folder name';
    if (n === '.' || n === '..') return 'A folder can\'t be named "." or ".."';
    if (/[/\\]/.test(n)) return 'A folder name can\'t contain "/" or "\\"';
    if (utf8Length(n) > MAX_NAME_BYTES) return 'The folder name is too long';
    if (hasInvisible(n, { joiners: true })) return 'The folder name contains invisible or control characters';
    if (isDotGitName(n, { platform })) return 'A folder can\'t be named ".git"';
    if (n.startsWith('.')) return 'A folder name can\'t start with a dot';
    if (n.includes(':')) return 'A folder name can\'t contain ":"';
    if (platform === 'win32') {
      if (DEVICE_NAME.test(n)) return `"${n}" is a name Windows reserves for a device`;
      if (/[. ]$/.test(n)) return 'On Windows a folder name can\'t end with a dot or a space';
      if (WIN_INVALID_CHARS.test(n)) return 'On Windows a folder name can\'t contain < > : " | ? *';
    }
    return null;
  }

  exports.MAX_URL = MAX_URL;
  exports.MAX_NAME_BYTES = MAX_NAME_BYTES;
  exports.parseCloneUrl = parseCloneUrl;
  exports.deriveName = deriveName;
  exports.nameError = nameError;
})(
  typeof module !== 'undefined' ? module.exports : (window.PLCloneUrl = {}), // NOSONAR(S1121): the CommonJS-or-window export idiom
  typeof module !== 'undefined' ? require('./display-text') : window.PLDisplayText,
  typeof module !== 'undefined' ? require('./path-names') : window.PLPathNames,
);
