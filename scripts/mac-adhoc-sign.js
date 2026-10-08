'use strict';
// electron-builder afterPack hook (package.json "build.afterPack"), build-time only. For the
// unsigned local build (npm run dist:mac:unsigned) it gives the app an ad-hoc signature before the
// DMG is made. The release build (npm run dist:mac) is signed with the Developer ID by
// electron-builder right after this hook, so the hook does nothing there.
//
// Why: electron-builder 26 has no ad-hoc option. Left unsigned, the bundle keeps Electron's linker
// signature on the renamed main binary, with an Info.plist and resources that no longer match
// it, and Apple silicon Macs report a downloaded copy as "damaged". A consistent ad-hoc signature
// runs locally and gets Gatekeeper's usual "could not verify" prompt elsewhere.
//
// electron-builder flips the Electron fuses ("build.electronFuses") after this hook, which edits
// the main binary and breaks this signature: `resetAdHocDarwinSignature` makes @electron/fuses
// sign the app ad hoc again right after flipping them (keeping entitlements, flags and the
// hardened runtime). The release build is signed with the Developer ID after that anyway.
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/** True when electron-builder will not sign this build (see "dist:mac:unsigned"). */
const unsignedBuild = (context) =>
  process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false' || context.packager.platformSpecificBuildOptions.identity === null;

module.exports = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin' || !unsignedBuild(context)) return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
