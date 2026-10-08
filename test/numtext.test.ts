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
  assert.equal(parseNumText('-1'), -1, 'the service decides what range is valid');
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
      s = { text: r.text, value: r.value };
      if (r.emit !== null) { saved.push(r.emit); s = { ...s, text: numFieldStep(s, { type: 'value', value: r.emit }).text }; }
    }
    return { text: s.text, value: s.value, saved };
  };
  assert.deepEqual(run(4, [{ type: 'type', text: '' }, { type: 'type', text: '6' }, { type: 'blur' }]), { text: '6', value: 6, saved: [6] });
  assert.deepEqual(run(4, [{ type: 'type', text: '' }, { type: 'blur' }]), { text: '4', value: 4, saved: [] }, 'left empty: back to 4, nothing saved');
  assert.deepEqual(run(4, [{ type: 'type', text: '' }, { type: 'value', value: 9 }]), { text: '9', value: 9, saved: [] }, 'reset from outside');
});
