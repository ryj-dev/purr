// The command line tool's link (~/.local/bin/purr) as PuRR.app sees it, and what Settings and the tray say about it.

export interface CliStatus {
  state: 'installed' | 'missing' | 'other' | 'blocked';   // this app's link, none, a link elsewhere, something not a link
  link: string;
  target: string | null;
  /** a link elsewhere that is another copy of PuRR (a PuRR.app, or a PuRR checkout's bin/purr), not some other tool */
  purrCopy: boolean;
  onPath: boolean;   // the link's folder is on PATH
}

/** What to offer for it: nothing to do, a button (and what it does), or something to clear by hand. */
export function cliAction(s: CliStatus): { kind: 'done' | 'install' | 'blocked'; button: string; tray: string; note: string } {
  if (s.state === 'installed') {
    return { kind: 'done', button: 'Installed', tray: 'Command line tool installed', note: s.onPath ? '' : 'Add ~/.local/bin to your PATH to use it.' };
  }
  if (s.state === 'blocked') {
    return { kind: 'blocked', button: 'Something else is there', tray: 'Install command line tool…',
      note: `${s.link} exists and isn't a link: move it aside to install.` };
  }
  if (s.state === 'other') {
    return s.purrCopy
      ? { kind: 'install', button: 'Point purr at this app', tray: 'Install command line tool…', note: `It points at another copy of PuRR now: ${s.target}.` }
      : { kind: 'install', button: 'Replace the link', tray: 'Install command line tool…', note: `It points at something else now: ${s.target}.` };
  }
  return { kind: 'install', button: 'Install purr', tray: 'Install command line tool…', note: '' };
}
