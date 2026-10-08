// When a sign-in started from the Toolchain popup counts as done: kept apart from React so it can be tested.
import type { ToolStatus } from '../../src/shared/types.ts';

type Auth = ToolStatus['auth'];

/**
 * Done when a tool that was signed out is signed in now (whether or not an account name shows: claude with an API key,
 * or a gh whose output PuRR can't read), or when a signed-in gh lists a different set of accounts (Add account).
 * Signing in again as an account already listed changes nothing: that wait is dismissed by hand, or ends by itself.
 */
export function signInDone(before: Auth, now: Auth): boolean {
  if (!now?.signedIn) return false;
  if (!before?.signedIn) return true;
  const list = (a: Auth) => [...(a?.accounts ?? [])].sort().join('\n');
  return list(now) !== list(before);
}
