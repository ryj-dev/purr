import './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNumText, settledText } from '../web/src/numText.ts';

test('number settings typed as text: empty stays empty while typing, and leaving it empty puts the value back', () => {
  assert.equal(parseNumText(''), null, 'cleared to type a new value: no 0 filled in');
  assert.equal(parseNumText('   '), null);
  assert.equal(parseNumText('6'), 6);
  assert.equal(parseNumText('06'), 6);
  assert.equal(parseNumText('abc'), null);
  assert.equal(parseNumText('-1'), -1, 'a number, not a valid setting: the service checks only the port and max sessions (other ranges: a follow-up)');
  assert.equal(settledText('', 4), '4', 'left empty: the last value');
  assert.equal(settledText('abc', 4), '4');
  assert.equal(settledText('6', 4), '6');
});

test('typing in a number box, step by step: never saves an empty box, and 4 -> 6 is 6', async () => {
  const { numFieldStep } = await import('../web/src/numText.ts');
  // drive the box as React does: each saved number comes back as the setting's new value
  const run = (start: number, events: Parameters<typeof numFieldStep>[1][]) => {
    let s = { text: String(start), value: start };
    const saved: number[] = [];
    for (const e of events) {
      const r = numFieldStep(s, e);
      if (r.emit === null) s = { text: r.text, value: r.value };
      if (r.emit !== null) {
        // the [value] effect runs only when the saved number differs from the setting before
        const before = s.value;
        saved.push(r.emit);
        s = { text: r.text, value: r.emit };
        if (r.emit !== before) s = { ...s, text: numFieldStep(s, { type: 'value', value: r.emit }).text };
      }
    }
    return { text: s.text, value: s.value, saved };
  };
  assert.deepEqual(run(4, [{ type: 'type', text: '' }, { type: 'type', text: '6' }, { type: 'blur' }]), { text: '6', value: 6, saved: [6] });
  assert.deepEqual(run(4, [{ type: 'type', text: '' }, { type: 'blur' }]), { text: '4', value: 4, saved: [] }, 'left empty: back to 4, nothing saved');
  assert.deepEqual(run(4, [{ type: 'type', text: '' }, { type: 'value', value: 9 }]), { text: '9', value: 9, saved: [] }, 'reset from outside');
  assert.deepEqual(run(6, [{ type: 'type', text: '06' }]), { text: '06', value: 6, saved: [6] }, 'the same number: the box keeps what was typed');
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
});
