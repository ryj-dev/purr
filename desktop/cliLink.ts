// What ~/.local/bin/purr is: kept apart from Electron so it can be tested.
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CliStatus } from '../src/shared/cliLink.ts';

/** Whether a link target is a copy of PuRR: inside a PuRR.app, or a checkout's bin/purr next to PuRR's package.json. */
function isPurr(target: string): boolean {
  if (/(^|\/)PuRR\.app\//.test(target)) return true;
  if (!/\/bin\/purr$/.test(target)) return false;
  try {
    const pkg = resolve(dirname(target), '..', 'package.json');
    return existsSync(pkg) && JSON.parse(readFileSync(pkg, 'utf8')).name === 'purr';
  } catch { return false; }
}

export function cliStatusOf(link: string, shim: string, path: string): CliStatus {
  const dir = resolve(dirname(link));
  const onPath = path.split(':').filter(Boolean).some((p) => resolve(p) === dir);   // resolve() drops a trailing slash
  const none = (state: CliStatus['state']): CliStatus => ({ state, link, target: null, purrCopy: false, onPath });
  let st;
  try { st = lstatSync(link); } catch { return none('missing'); }
  if (!st.isSymbolicLink()) return none('blocked');
  let raw: string;
  try { raw = readlinkSync(link); } catch { return none('missing'); }   // removed meanwhile
  const target = resolve(dirname(link), raw);   // a relative link points from the link's folder
  if (target === resolve(shim)) return { state: 'installed', link, target, purrCopy: false, onPath };
  return { state: 'other', link, target, purrCopy: isPurr(target), onPath };
}

/**
 * Links `link` to `shim`. Only ever replaces a link: a file or folder at `link` is left alone, as is a link that is
 * already right.
 */
export function installCliAt(link: string, shim: string, path: string): { ok: boolean; message: string } {
  try {
    const before = cliStatusOf(link, shim, path);
    if (before.state === 'blocked') return { ok: false, message: `${link} exists and isn't a link; move it aside first.` };
    if (before.state === 'installed') return { ok: true, message: `${link} already points at this app.` };
    mkdirSync(dirname(link), { recursive: true });
    if (before.state === 'other') unlinkSync(link);
    symlinkSync(shim, link);
    const after = cliStatusOf(link, shim, path);
    return { ok: true, message: `Linked ${link} → ${shim}.${after.onPath ? '' : ` Add ${dirname(link)} to your PATH to use it.`}` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
