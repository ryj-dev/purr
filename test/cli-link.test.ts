import './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cliStatusOf } from '../desktop/cliLink.ts';
import { cliAction } from '../src/shared/cliLink.ts';

test("the command line tool's link: missing, something in the way, this app's, another PuRR's, something else's", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR!, 'purr-cli-'));
  const shim = '/Applications/PuRR.app/Contents/Resources/bin/purr';
  const at = (name: string) => join(dir, name);
  assert.deepEqual(cliStatusOf(at('none'), shim, ''), { state: 'missing', link: at('none'), target: null, purrCopy: false, onPath: false });
  writeFileSync(at('file'), '#!/bin/sh\n');
  assert.equal(cliStatusOf(at('file'), shim, '').state, 'blocked');
  mkdirSync(at('folder'));
  assert.equal(cliStatusOf(at('folder'), shim, '').state, 'blocked', "a folder in the way isn't a link either");
  symlinkSync(shim, at('mine'));
  assert.deepEqual(cliStatusOf(at('mine'), shim, `/usr/bin:${dir}`), { state: 'installed', link: at('mine'), target: shim, purrCopy: false, onPath: true });
  assert.equal(cliStatusOf(at('mine'), shim, `${dir}/`).onPath, true, 'a PATH entry with a trailing slash still counts');

  // a PuRR checkout's bin/purr (package.json says purr) or another PuRR.app is a copy of PuRR; another tool's isn't
  const checkout = at('checkout');
  mkdirSync(join(checkout, 'bin'), { recursive: true });
  writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'purr' }));
  symlinkSync(join(checkout, 'bin', 'purr'), at('dev'));
  assert.deepEqual([cliStatusOf(at('dev'), shim, '').state, cliStatusOf(at('dev'), shim, '').purrCopy], ['other', true]);
  symlinkSync('/Applications/Old/PuRR.app/Contents/Resources/bin/purr', at('oldapp'));
  assert.equal(cliStatusOf(at('oldapp'), shim, '').purrCopy, true);
  symlinkSync('/usr/local/bin/purr', at('theirs'));
  assert.deepEqual([cliStatusOf(at('theirs'), shim, '').state, cliStatusOf(at('theirs'), shim, '').purrCopy], ['other', false]);

  // a link whose target is gone is still a link elsewhere; a relative one points from the link's folder
  symlinkSync(join(dir, 'gone'), at('dangling'));
  assert.equal(cliStatusOf(at('dangling'), shim, '').state, 'other');
  const local = mkdtempSync(join(process.env.TMPDIR!, 'purr-cli-rel-'));
  mkdirSync(join(local, 'app'));
  symlinkSync('app/purr', join(local, 'rel'));
  assert.equal(cliStatusOf(join(local, 'rel'), join(local, 'app', 'purr'), '').state, 'installed');
});

test('what Settings and the tray offer for each state of the link', () => {
  const base = { link: '/Users/me/.local/bin/purr', target: null, purrCopy: false, onPath: true };
  const of = (o: object) => cliAction({ ...base, ...o } as any);
  assert.deepEqual([of({ state: 'missing' }).kind, of({ state: 'missing' }).button], ['install', 'Install purr']);
  assert.deepEqual([of({ state: 'installed' }).kind, of({ state: 'installed' }).tray, of({ state: 'installed' }).note],
    ['done', 'Command line tool installed', '']);
  assert.match(of({ state: 'installed', onPath: false }).note, /PATH/);
  assert.equal(of({ state: 'other', purrCopy: true, target: '/x/PuRR.app/bin/purr' }).button, 'Point purr at this app');
  assert.equal(of({ state: 'other', target: '/usr/local/bin/purr' }).button, 'Replace the link');
  assert.match(of({ state: 'other', target: '/usr/local/bin/purr' }).note, /something else.*\/usr\/local\/bin\/purr/);
  assert.equal(of({ state: 'blocked' }).kind, 'blocked');
  assert.match(of({ state: 'blocked' }).tray, /in the way/, 'the tray says so too, instead of offering an install that can only fail');
  assert.match(of({ state: 'blocked' }).note, /isn't a link/);
});
