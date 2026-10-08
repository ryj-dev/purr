// Number settings are edited as text: what a box's text means, kept apart from React so it can be tested.

/** The number typed, or null while the box is empty or not a number yet (the setting keeps its last value). */
export function parseNumText(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** What a box shows once you leave it: what you typed if it's a number, else the setting's value. */
export const settledText = (text: string, value: number) => (parseNumText(text) === null ? String(value) : text);
