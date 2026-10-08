'use strict';
// ESLint flat config: the recommended rules (less one, below), no style rules (see CONTRIBUTING.md).
//
// ESLint, @eslint/js and globals are exact-pinned devDependencies (their own dependencies are
// pinned by package-lock.json), so `npm run lint` runs what `npm ci` installed.
const js = require('@eslint/js');
const globals = require('globals');

// The renderer's plain scripts share these through window (each file sets one of them).
const RENDERER_GLOBALS = Object.fromEntries([
  'Components', 'Graph', 'PL', 'PLColumns', 'PLComposer', 'PLDiff', 'PLDiffStaging', 'PLErrorKinds',
  'PLFileList', 'PLFlowKit', 'PLFlows', 'PLHistory', 'PLIcons', 'PLImage', 'PLImageCache', 'PLImageFormat',
  'PLImagePreview', 'PLKeys', 'PLMenus', 'PLOp', 'PLPolicy', 'PLRebase', 'PLRepoPicker', 'PLWip', 'Store',
].map((name) => [name, 'readonly']));

module.exports = [
  { ignores: ['node_modules/', 'coverage/', 'dist/', 'out/', '.scannerwork/', 'demo-repo*/'] },
  js.configs.recommended,
  {
    // The one recommended rule turned off: the code strips control characters from git output
    // and user input on purpose (sanitising names, messages and ANSI escapes), with regexes.
    rules: { 'no-control-regex': 'off' },
  },
  {
    // Node (CommonJS): the git layer, the main process, tests and scripts.
    files: ['**/*.js'],
    ignores: ['renderer/**'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },
  {
    // Sandboxed preloads: require('electron') only, running next to the page.
    files: ['preload.js', 'preload-tabs.js'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // Smoke page scripts (PL_SMOKE_JS, main/smoke.js): evaluated in the renderer page, not Node.
    files: ['scripts/smoke/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
  },
  {
    // Renderer: plain scripts loaded by <script> tags (no modules, no bundler). Most of them
    // also export through module.exports when a test requires them under Node.
    // src/error-kinds.js and src/image-format.js (the image preview's format catalogue) are loaded
    // by index.html too.
    files: ['renderer/**/*.js', 'src/error-kinds.js', 'src/image-format.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: { ...globals.browser, ...RENDERER_GLOBALS, module: 'readonly', require: 'readonly' },
    },
  },
];
