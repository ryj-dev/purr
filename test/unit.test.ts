import './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson } from '../src/server/util.ts';
import { parseDiff } from '../src/server/git.ts';
import { DEFAULT_FLOWS } from '../src/server/flows/defaults.ts';
import { graph, rootContext, sessionSource, validateFlow } from '../src/server/flows/validate.ts';
import { dedupe, fingerprint, normalizeFinding } from '../src/server/engine/findings.ts';
import type { Block, Edge, Finding } from '../src/shared/types.ts';

test('extractJson takes the last parseable array, ignoring prose and brackets in strings', () => {
  assert.deepEqual(extractJson('Thoughts [not json] then\n[{"a": "x]y"}]'), [{ a: 'x]y' }]);
  assert.deepEqual(extractJson('```json\n[1,2]\n```\nfinal: [3]'), [3]);
  assert.deepEqual(extractJson('{"real": true, "note": "a {b}"}', 'object'), { real: true, note: 'a {b}' });
  assert.equal(extractJson('no json here'), undefined);
  assert.deepEqual(extractJson('[]'), []);
});

test('parseDiff maps added lines to new-file line numbers', () => {
  const diff = [
    'diff --git a/x.js b/x.js', 'index 1..2 100644', '--- a/x.js', '+++ b/x.js',
    '@@ -1,0 +2,2 @@', '+one', '+two', '@@ -10 +12 @@', '-old', '+new',
    'diff --git a/n.txt b/n.txt', 'new file mode 100644', '--- /dev/null', '+++ b/n.txt', '@@ -0,0 +1 @@', '+hi',
  ].join('\n');
  const files = parseDiff(diff);
  assert.equal(files.length, 2);
  assert.deepEqual([...files[0].added.entries()], [[2, 'one'], [3, 'two'], [12, 'new']]);
  assert.equal(files[0].deletions, 1);
  assert.equal(files[1].status, 'added');
  assert.equal(files[1].added.get(1), 'hi');
});

test('parseDiff treats +++/--- inside a hunk as content and unquotes odd paths', () => {
  const diff = [
    'diff --git a/x.md b/x.md', '--- a/x.md', '+++ b/x.md', '@@ -1 +1,2 @@', '+++ not a header', '--- also content', '+tail',
    'diff --git "a/caf\\303\\251 menu.txt" "b/caf\\303\\251 menu.txt"', '--- "a/caf\\303\\251 menu.txt"', '+++ "b/caf\\303\\251 menu.txt"', '@@ -0,0 +1 @@', '+x',
  ].join('\n');
  const files = parseDiff(diff);
  assert.equal(files[0].path, 'x.md');
  assert.deepEqual([...files[0].added.entries()], [[1, '++ not a header'], [2, 'tail']]);
  assert.equal(files[0].deletions, 1);
  assert.equal(files[1].path, 'café menu.txt');
});

test('default flows validate with no errors', () => {
  for (const f of DEFAULT_FLOWS) {
    const errors = validateFlow(f.blocks, f.edges).filter((i) => i.level === 'error');
    assert.deepEqual(errors, [], f.name);
  }
});

test('full review: lenses fork the seed via the branch, severity/verify fork the seed directly', () => {
  const f = DEFAULT_FLOWS.find((x) => x.id === 'default-review')!;
  const g = graph(f.blocks, f.edges);
  assert.deepEqual(sessionSource(g, 'lens-security'), { source: 'context' });
  assert.deepEqual(sessionSource(g, 'severity'), { source: 'context' });
  assert.equal(rootContext(g, 'verify')?.id, 'context');
});

const b = (id: string, type: Block['type'], config: any = {}): Block => ({ id, type, label: id, position: { x: 0, y: 0 }, config });
const e = (s: string, t: string): Edge => ({ id: `${s}-${t}`, source: s, target: t });
const ctx = { model: 'sonnet', prompt: 'x', maxTurns: 5, tools: ['Read'], allowedTools: [] };
const prompt = { prompt: 'p {{finding_schema}}', allowedTools: [], output: 'findings', forkFrom: null, maxTurns: 5, category: 'x' };

test('validation catches cycles, sessionless prompts, bad forkFrom and branch misuse', () => {
  const msgs = (blocks: Block[], edges: Edge[]) => validateFlow(blocks, edges).filter((i) => i.level === 'error').map((i) => i.message).join(' | ');
  assert.match(msgs([b('a', 'merge'), b('c', 'merge')], [e('a', 'c'), e('c', 'a')]), /cycle/);
  assert.match(msgs([b('s', 'scanner', { scanner: 'betterleaks' }), b('p', 'prompt', prompt)], [e('s', 'p')]), /Needs a session/);
  assert.match(msgs([b('c', 'context', ctx), b('p', 'prompt', { ...prompt, forkFrom: 'c' })], []), /must come before/);
  assert.match(msgs([b('s', 'scanner', { scanner: 'betterleaks' }), b('br', 'branch')], [e('s', 'br')]), /must follow a context/);
  assert.match(msgs([b('c1', 'context', ctx), b('c2', 'context', ctx), b('p', 'prompt', prompt)], [e('c1', 'p'), e('c2', 'p')]), /more than one session/);
  assert.equal(msgs([b('c', 'context', ctx), b('br', 'branch'), b('p1', 'prompt', prompt), b('p2', 'prompt', prompt)],
    [e('c', 'br'), e('br', 'p1'), e('br', 'p2')]), '');
});

const f = (over: Partial<Finding>): Finding => ({
  id: Math.random().toString(36), file: 'a.ts', line: 10, category: 'logic', severity: 'consider', title: 't', scenario: 's',
  source: { blockId: 'x', kind: 'model' }, ...over,
});

test('dedupe merges same-place same-category findings and keeps the most severe', () => {
  const out = dedupe([
    f({ line: 10, severity: 'consider', title: 'Divides by zero when count is zero', source: { blockId: 'lens-a', kind: 'model' } }),
    f({ line: 12, severity: 'must_fix', title: 'Division by zero when count is zero', source: { blockId: 'lens-b', kind: 'model' } }),
    f({ line: 11, title: 'Off-by-one drops the last page of results' }),
    f({ line: 40 }),
    f({ line: 11, category: 'security', title: 'unrelated thing entirely', scenario: 'other words' }),
  ]);
  assert.equal(out.length, 4, 'adjacent but different bugs stay separate');
  assert.equal(out[0].severity, 'must_fix');
  assert.deepEqual(out[0].alsoFoundBy, ['lens-a']);
});

test('fingerprint is stable across line shifts but changes with the code', () => {
  const content = 'a\nb\nc\nconst x = y / n;\nd\ne\nf\n';
  const shifted = 'new line\n' + content;
  const a = fingerprint(f({ line: 4 }), content);
  assert.equal(a, fingerprint(f({ line: 5 }), shifted));
  assert.notEqual(a, fingerprint(f({ line: 4 }), content.replace('y / n', 'y / (n || 1)')));
});

test('normalizeFinding fills defaults and rejects findings without a file', () => {
  assert.equal(normalizeFinding({ body: 'x' }, 'b', 'logic'), null);
  const n = normalizeFinding({ file: './src/a.ts', line: '7', body: 'Broken thing. More detail.', label: 'must_fix' }, 'b', 'logic')!;
  assert.equal(n.file, 'src/a.ts');
  assert.equal(n.line, 7);
  assert.equal(n.severity, 'must_fix');
  assert.equal(n.title, 'Broken thing.');
  assert.equal(n.category, 'logic');
});
