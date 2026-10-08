import type { BlockStatus, RunStatus, Run } from '../../../src/shared/types.ts';
import { StationMark } from './Station.tsx';

export const STATUS_CLS: Record<string, string> = {
  queued: 'muted', pending: 'muted', running: 'info', passed: 'ok', done: 'ok', blocked: 'warn',
  failed: 'danger', cancelled: 'muted', superseded: 'muted', skipped: 'muted',
};

export function StatusIcon({ status, size = 13 }: { status: RunStatus | BlockStatus; size?: number }) {
  return <StationMark status={status} size={size} />;
}

export function StatusChip({ status }: { status: RunStatus | BlockStatus }) {
  return <span className={`status ${STATUS_CLS[status] ?? 'muted'}`}><StationMark status={status} />{status}</span>;
}

export function Counts({ counts }: { counts: Run['counts'] }) {
  // only non-zero severities render, left-aligned; colour says which is which, so clean runs read as empty
  if (counts.must_fix + counts.consider + counts.minor === 0) return <span className="counts none" aria-label="No findings" />;
  const c = (n: number, cls: string, t: string) => (n === 0 ? null : <span className={cls} title={`${t}: ${n}`}>{n}</span>);
  return (
    <span className="counts">
      {c(counts.must_fix, 'm', 'Must fix')}
      {c(counts.consider, 'c', 'Consider')}
      {c(counts.minor, 'n', 'Minor')}
    </span>
  );
}
