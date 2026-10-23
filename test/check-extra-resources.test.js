'use strict';
// scripts/check-extra-resources.js: the beforePack hook that stops a build missing an
// extraResources source (the Electron license files, when the binary was never downloaded).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const checkExtraResources = require('../scripts/check-extra-resources');

const { missingResources } = checkExtraResources;
const { build } = require('../package.json');
const ROOT = path.resolve('/project');

test('package.json runs the hook before packing, on every platform', () => {
  assert.equal(build.beforePack, 'scripts/check-extra-resources.js');
});

test("package.json's sources: the Electron license files missing are reported, the rest not", () => {
  const electronDist = path.join(ROOT, 'node_modules', 'electron', 'dist');
  const missing = missingResources({ config: build, projectDir: ROOT, exists: (p) => !p.startsWith(electronDist) });
  assert.deepEqual(missing, [path.join(electronDist, 'LICENSE'), path.join(electronDist, 'LICENSES.chromium.html')]);
  assert.deepEqual(missingResources({ config: build, projectDir: ROOT, exists: () => true }), []);
});

test("string entries and the platform's own extraResources count too", () => {
  const missing = missingResources({
    config: { extraResources: ['NOTICE', { from: 'LICENSE', to: 'LICENSE' }] },
    platformConfig: { extraResources: { from: 'linux/extra', to: 'extra' } },
    projectDir: ROOT,
    exists: () => false,
  });
  assert.deepEqual(missing, ['NOTICE', 'LICENSE', 'linux/extra'].map((p) => path.join(ROOT, p)));
});

test('no extraResources: nothing missing', () => {
  assert.deepEqual(missingResources({ config: {}, platformConfig: null, projectDir: ROOT, exists: () => false }), []);
});

test('the hook throws, naming the missing files and the fix', async () => {
  const context = {
    packager: { config: { extraResources: [{ from: 'no-such-file-here', to: 'x' }] }, platformSpecificBuildOptions: {}, projectDir: __dirname },
  };
  await assert.rejects(checkExtraResources(context), (err) => {
    assert.match(err.message, /no-such-file-here/);
    assert.match(err.message, /npx install-electron/);
    return true;
  });
  context.packager.config.extraResources = [{ from: 'check-extra-resources.test.js', to: 'x' }];
  await checkExtraResources(context);
});
