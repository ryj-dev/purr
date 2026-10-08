// Bridge exposed by PuRR.app's preload script (desktop/preload.ts). Absent in a normal browser.
interface PurrDesktop {
  isDesktop: true;
  version: string;
  getLoginItem(): Promise<boolean>;
  setLoginItem(enabled: boolean): Promise<boolean>;
  installCli(): Promise<{ ok: boolean; message: string }>;
  /** ~/.local/bin/purr: this app's link, none, a link to another copy, or a file in the way */
  cliStatus(): Promise<{ state: 'installed' | 'missing' | 'other' | 'blocked'; link: string; target: string | null; onPath: boolean }>;
}
interface Window { purrDesktop?: PurrDesktop }
