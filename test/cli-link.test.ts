import './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cliStatusOf } from '../desktop/cliLink.ts';

test("the command line tool's link: missing, a file in the way, this app's, another PuRR's, something else's", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR!, 'purr-cli-'));
  const shim = '/Applications/PuRR.app/Contents/Resources/bin/purr';
  const at = (name: string) => join(dir, name);
  assert.deepEqual(cliStatusOf(at('none'), shim, ''), { state: 'missing', link: at('none'), target: null, purrCopy: false, onPath: false });
  writeFileSync(at('file'), '#!/bin/sh\n');
  assert.equal(cliStatusOf(at('file'), shim, '').state, 'blocked');
  symlinkSync(shim, at('mine'));
  assert.deepEqual(cliStatusOf(at('mine'), shim, `/usr/bin:${dir}`), { state: 'installed', link: at('mine'), target: shim, purrCopy: false, onPath: true });
  symlinkSync('/Users/me/src/purr/bin/purr', at('dev'));
  assert.deepEqual([cliStatusOf(at('dev'), shim, '').state, cliStatusOf(at('dev'), shim, '').purrCopy], ['other', true], 'a checkout\'s shim');
  symlinkSync('/opt/homebrew/bin/purr-something', at('theirs'));
  assert.deepEqual([cliStatusOf(at('theirs'), shim, '').state, cliStatusOf(at('theirs'), shim, '').purrCopy], ['other', false], 'not PuRR');
});
