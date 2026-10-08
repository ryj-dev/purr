// Where PuRR's pieces live. Two ways to run it:
//  - from the source checkout: bin/purr runs these .ts files with the system node;
//  - from PuRR.app: the app's own runtime runs the bundled server (desktop/main.ts and build/bin/purr set the env vars).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './util.ts';

function packageVersion(): string {
  try { return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; }
}

export const VERSION = process.env.PURR_BUILD_VERSION || packageVersion();
/** The built web UI the daemon serves. */
export const WEB_DIR = process.env.PURR_WEB_DIR || join(ROOT, 'dist/web');
/** The `purr` command git hooks call. In the app it's the launcher inside the bundle. */
export const SHIM = process.env.PURR_SHIM || join(ROOT, 'bin/purr');
/** Started by PuRR.app: desktop notifications go through the app (native, clickable) instead of osascript. */
export const APP_MANAGED = process.env.PURR_APP === '1';
