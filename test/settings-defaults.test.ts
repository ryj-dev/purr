import './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, openDb } from '../src/server/db.ts';
import { ClaudeRunner, QuotaError } from '../src/server/claude.ts';
import { DEFAULT_FLOWS } from '../src/server/flows/defaults.ts';

const fresh = () => join(mkdtempSync(join(process.env.TMPDIR!, 'purr-db-')), 'purr.db');

test("the default limit lets the default full review's lenses all run at once", () => {
  const review = DEFAULT_FLOWS.find((f) => f.id === 'default-review')!;
  const lenses = review.blocks.filter((b) => b.type === 'prompt' && review.edges.some((e) => e.source === 'branch' && e.target === b.id));
  assert.ok(lenses.length > 0);
  assert.ok(DEFAULT_SETTINGS.maxConcurrentClaude >= lenses.length, `${DEFAULT_SETTINGS.maxConcurrentClaude} slots for ${lenses.length} lenses`);
});

test('saved settings keep only what differs from the defaults, so a new default reaches people who left it alone', () => {
  const db = openDb(fresh());
  db.setSettings({ ...db.getSettings(), dailySessionCap: 50 });
  const stored = JSON.parse((db.raw.prepare("SELECT value FROM kv WHERE key = 'settings'").get() as { value: string }).value);
  assert.equal(stored.dailySessionCap, 50);
  assert.equal('maxConcurrentClaude' in stored, false, 'left at the default: not stored');
  assert.equal(db.getSettings().maxConcurrentClaude, DEFAULT_SETTINGS.maxConcurrentClaude);
  db.close();
});

test('once: a saved 4 Claude sessions (the old default, saved with everything else) gives way to the new default', () => {
  const file = fresh();
  const old = openDb(file);
  old.raw.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('settings', ?)").run(JSON.stringify({ maxConcurrentClaude: 4, dailySessionCap: 300, port: 7878 }));
  old.raw.prepare("DELETE FROM kv WHERE key = 'migrations'").run();
  old.close();
  const db = openDb(file);
  assert.equal(db.getSettings().maxConcurrentClaude, 6);
  db.setSettings({ ...db.getSettings(), maxConcurrentClaude: 4 });   // chosen again on purpose
  db.close();
  assert.equal(openDb(file).getSettings().maxConcurrentClaude, 4, 'not dropped a second time');
});

test("the daily session cap counts sessions still running, not just finished ones", () => {
  const db = openDb(fresh());
  db.setSettings({ ...db.getSettings(), dailySessionCap: 2 });
  const claude = new ClaudeRunner(db);
  claude.checkQuota();                      // none running, none recorded
  claude.running = 2;                        // two started together, neither finished
  assert.throws(() => claude.checkQuota(), QuotaError);
  db.close();
});
