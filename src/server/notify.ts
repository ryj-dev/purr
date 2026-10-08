import { exec } from './util.ts';

/** macOS desktop notification via osascript; a no-op elsewhere or if it fails. */
export async function notify(title: string, message: string) {
  if (process.platform !== 'darwin') return;
  const q = (s: string) => JSON.stringify(s.slice(0, 240));
  try { await exec('/usr/bin/osascript', ['-e', `display notification ${q(message)} with title ${q(title)}`], { timeoutMs: 5000 }); } catch { /* ignore */ }
}
