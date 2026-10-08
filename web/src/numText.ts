// Number settings are edited as text: what a box's text means, kept apart from React so it can be tested.

/** The number typed, or null while the box is empty or not a number yet (the setting keeps its last value). */
export function parseNumText(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}


export type NumEvent = { type: 'type'; text: string } | { type: 'value'; value: number };   // leaving the box: numFieldHandlers.blur

/**
 * One step of a number box. `value` is the setting; the result is the box's new text, the setting after it, and the
 * number to save (null: leave the setting alone, as while the box is empty).
 */
export function numFieldStep(s: { text: string; value: number }, e: NumEvent): { text: string; value: number; emit: number | null } {
  if (e.type === 'type') {
    const v = parseNumText(e.text);
    return { text: e.text, value: v ?? s.value, emit: v };
  }
  return { text: String(e.value), value: e.value, emit: null };   // loaded, saved or reset from outside
}

/**
 * A number box's handlers, used by NumField itself and by its tests: a keystroke, leaving the box, and the setting
 * changing from outside (NumField calls `value` from an effect on the setting, so only when it actually changes).
 */
export function numFieldHandlers(get: () => { text: string; value: number }, setText: (t: string) => void, save: (v: number) => void,
  memo: { before: number | null; saved?: number | null } = { before: null }) {
  return {
    /** Remembers the value from before this edit: backspacing 7878 away saves 787, 78 and 7 on the way. */
    focus: () => { memo.before = get().value; },
    type: (text: string) => {
      if (memo.before === null) memo.before = get().value;
      const r = numFieldStep(get(), { type: 'type', text });
      setText(r.text);
      if (r.emit !== null) { memo.saved = r.emit; save(r.emit); }
    },
    /** Left empty (or not a number): back to the value from before the edit, saved again if typing changed it. */
    blur: () => {
      const { text, value } = get();
      const before = memo.before ?? value;
      memo.before = null;
      if (parseNumText(text) !== null) return;
      setText(String(before));
      if (before !== value) { memo.saved = before; save(before); }
    },
    value: (value: number) => {
      // changed elsewhere mid-edit (a reload, another window): that is the value to go back to now, not the old one.
      // The box's own saves come back here too (787, 78, 7 while backspacing 7878): those don't count
      if (memo.before !== null && value !== memo.saved) memo.before = value;
      setText(numFieldStep(get(), { type: 'value', value }).text);
    },
  };
}

/**
 * NumField's effect, run after every render: tells the box about the setting only when it is a new value (so a box
 * someone has just cleared isn't refilled by a re-render). Returns the value to remember for next time.
 */
export function syncValue(last: number | undefined, value: number, box: { value: (v: number) => void }): number {
  if (last !== undefined && last !== value) box.value(value);
  return value;
}
