'use strict';
// electron-builder beforePack hook (package.json "build.beforePack"), build-time only, every
// platform. build.extraResources ships Electron's and Chromium's license notices from
// node_modules/electron/dist, which npm ci doesn't create: Electron 44 downloads its binary on
// first use, or with `install-electron` (the dist:* scripts run it first). electron-builder only
// warns about a missing extraResources source and builds the app without it, so this hook stops
// the build instead.
const fs = require('node:fs');
const path = require('node:path');

/** The `from` of each extraResources entry (a string, or {from, to, filter}). */
const sources = (entries) => [].concat(entries || []).map((e) => (typeof e === 'string' ? e : e.from)).filter(Boolean);

/**
 * The extraResources sources (top-level and the platform's own) that don't exist under
 * `projectDir`, as absolute paths. `exists` for tests.
 */
function missingResources({ config, platformConfig, projectDir, exists = fs.existsSync }) {
  return [...sources(config.extraResources), ...sources(platformConfig && platformConfig.extraResources)]
    .map((from) => path.resolve(projectDir, from))
    .filter((p) => !exists(p));
}

module.exports = async function checkExtraResources(context) {
  const missing = missingResources({
    config: context.packager.config,
    platformConfig: context.packager.platformSpecificBuildOptions,
    projectDir: context.packager.projectDir,
  });
  if (missing.length) {
    throw new Error(`build.extraResources source missing: ${missing.join(', ')}. `
      + 'For the Electron license files, run npx install-electron first (the dist:* scripts do).');
  }
};

module.exports.missingResources = missingResources;
