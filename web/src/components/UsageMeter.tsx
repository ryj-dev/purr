export function UsageMeter({ label, value, resetsAt, large }: { label: string; value: number | null; resetsAt?: string | null; large?: boolean }) {
  const pct = value == null ? null : Math.round(value * 100);
  const cls = pct == null ? '' : pct >= 85 ? 'high' : pct >= 60 ? 'mid' : '';
  const title = resetsAt ? `Resets ${new Date(resetsAt).toLocaleString()}` : 'Reported by Claude Code after each session';
  const bar = <div className="bar"><div className={`fill ${cls}`} style={{ transform: `scaleX(${(pct ?? 0) / 100})` }} /></div>;
  if (large) {
    return (
      <div className="meter lg" title={title}>
        <div className="top"><span className="lbl">{label}</span><span className="pct">{pct == null ? '—' : `${pct}%`}</span></div>
        {bar}
        <span className="hint">{resetsAt ? `Resets ${new Date(resetsAt).toLocaleString()}` : 'No reading yet'}</span>
      </div>
    );
  }
  return (
    <div className="meter" title={title}>
      <span className="lbl">{label}</span>
      {bar}
      <span className="pct">{pct == null ? '—' : `${pct}%`}</span>
    </div>
  );
}
