// What ~/.local/bin/purr is: kept apart from Electron so it can be tested.
import { lstatSync, readlinkSync } from 'node:fs';
import { dirname } from 'node:path';

export interface CliStatus {
  state: 'installed' | 'missing' | 'other' | 'blocked';   // this app's link, none, a link elsewhere, a file in the way
  link: string;
  target: string | null;
  /** a link elsewhere that looks like another copy of PuRR (its bin/purr shim), not some other tool's purr */
  purrCopy: boolean;
  onPath: boolean;   // the link's folder is on PATH
}

export function cliStatusOf(link: string, shim: string, path: string): CliStatus {
  const onPath = path.split(':').includes(dirname(link));
  const none = (state: CliStatus['state']): CliStatus => ({ state, link, target: null, purrCopy: false, onPath });
  let st;
  try { st = lstatSync(link); } catch { return none('missing'); }
  if (!st.isSymbolicLink()) return none('blocked');
  let target: string;
  try { target = readlinkSync(link); } catch { return none('missing'); }   // removed meanwhile
  if (target === shim) return { state: 'installed', link, target, purrCopy: false, onPath };
  return { state: 'other', link, target, purrCopy: /(^|\/)PuRR\.app\/|\/bin\/purr$/.test(target), onPath };
}
