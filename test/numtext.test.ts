import './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNumText } from '../web/src/numText.ts';

test('number settings typed as text: empty or not a number is no number yet', () => {
  assert.equal(parseNumText(''), null, 'cleared to type a new value: no 0 filled in');
  assert.equal(parseNumText('   '), null);
  assert.equal(parseNumText('6'), 6);
  assert.equal(parseNumText('06'), 6);
  assert.equal(parseNumText('abc'), null);
  assert.equal(parseNumText('-1'), -1, 'a number, not a valid setting: the service checks only the port and max sessions (other ranges: a follow-up)');
});

test("NumField's own handlers: clear 4, type 6, leave; clear and leave; '06' over 6", async () => {
  const { numFieldHandlers } = await import('../web/src/numText.ts');
  // the component's state and props, and its effect after each render (syncValue, the same function NumField runs).
  // Like React, a state change re-renders after the handler returns, and the effect runs after that render
  const { syncValue } = await import('../web/src/numText.ts');
  const box = (start: number) => {
    const s = { text: String(start), value: start, saved: [] as number[], last: undefined as number | undefined };
    let dirty = true;
    const flush = () => { while (dirty) { dirty = false; s.last = syncValue(s.last, s.value, h); } };
    const h0 = numFieldHandlers(() => ({ text: s.text, value: s.value }), (t) => { s.text = t; dirty = true; }, (v) => { s.saved.push(v); s.value = v; dirty = true; },
      { before: null });
    const h = { ...h0, type: (t: string) => { h0.type(t); flush(); }, blur: () => { h0.blur(); flush(); }, focus: () => { h0.focus(); flush(); } };
    flush();
    // the setting changes somewhere else (a reload, Save, another window): the box shows it
    const outside = (v: number) => { s.value = v; dirty = true; flush(); };
    return { s, h, outside };
  };
  let b = box(4);
  b.h.type('');
  assert.deepEqual([b.s.text, b.s.saved], ['', []], 'cleared: empty, nothing saved, no 0');
  b.h.type('6');
  b.h.blur();
  assert.deepEqual([b.s.text, b.s.value, b.s.saved], ['6', 6, [6]]);
  b = box(4);
  b.h.type('');
  b.h.blur();
  assert.deepEqual([b.s.text, b.s.value, b.s.saved], ['4', 4, []]);
  b = box(6);
  b.h.type('06');
  assert.deepEqual([b.s.text, b.s.saved], ['06', [6]], 'the same number: kept as typed');
  // backspacing a long number away saves each shorter one; leaving it empty puts the whole number back, saved
  b = box(7878);
  b.h.focus();
  for (const t of ['787', '78', '7', '']) b.h.type(t);
  b.h.blur();
  assert.deepEqual([b.s.text, b.s.value, b.s.saved.at(-1)], ['7878', 7878, 7878]);
  b = box(4);
  b.outside(8);
  assert.equal(b.s.text, '8', 'changed elsewhere: shown');
  b.h.type('');
  b.outside(9);
  assert.equal(b.s.text, '9', 'even over a box someone had cleared');
  b.h.type('');
  b.h.blur();
  assert.deepEqual([b.s.text, b.s.value, b.s.saved], ['9', 9, []], 'cleared again and left: the new value, not the stale 4, and nothing saved');
});
