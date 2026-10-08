// Bridge exposed by PuRR.app's preload script (desktop/preload.ts). Absent in a normal browser.
interface PurrDesktop {
  isDesktop: true;
  version: string;
  getLoginItem(): Promise<boolean>;
  setLoginItem(enabled: boolean): Promise<boolean>;
  installCli(): Promise<{ ok: boolean; message: string }>;
}
interface Window { purrDesktop?: PurrDesktop }
