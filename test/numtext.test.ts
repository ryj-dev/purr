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
