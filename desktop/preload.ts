// The only things the web UI can ask PuRR.app for. Everything else goes through the service's HTTP API as in a browser.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('purrDesktop', {
  isDesktop: true,
  version: ipcRenderer.sendSync('purr:version') as string,
  getLoginItem: () => ipcRenderer.invoke('purr:get-login-item'),
  setLoginItem: (enabled: boolean) => ipcRenderer.invoke('purr:set-login-item', enabled),
  installCli: () => ipcRenderer.invoke('purr:install-cli'),
  cliStatus: () => ipcRenderer.invoke('purr:cli-status'),
});
