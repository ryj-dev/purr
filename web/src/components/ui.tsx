import type { CSSProperties, ReactNode } from 'react';
import {
  CircleAlert, CircleArrowUp, GitCommitHorizontal, Hand, Info, OctagonAlert, TriangleAlert, Upload, type LucideIcon,
} from 'lucide-react';
import type { BlockType, Severity, TriggerKind } from '../../../src/shared/types.ts';
import { BLOCK_META, SEVERITY_LABEL } from '../util.ts';
import logoSvg from '../../../build/logo.svg?raw';

// PuRR's mark comes from build/logo.svg, the same file the app and menu-bar icons are rendered from.
const LOGO = logoSvg;
const logoAttr = (id: string, name: string) =>
  LOGO.match(new RegExp(`id="${id}"[^>]*?\\s${name}="([^"]*)"`, 's'))?.[1] ?? LOGO.match(new RegExp(`${name}="([^"]*)"[^>]*?id="${id}"`, 's'))?.[1] ?? '';
const CAT = logoAttr('cat', 'd');
const WHISKERS = logoAttr('whiskers', 'd');
const WHISKER_W = logoAttr('whiskers', 'stroke-width');

/** PuRR's mark: a cat whose whiskers are >/<, on a small tile (inverts with the theme, like the app icon on a light tile). */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <span className="logo" style={{ width: size, height: size }} aria-hidden>
      <svg width={size} height={size} viewBox="10 12 80 80">
        <path d={CAT} fill="var(--logo-cat)" />
        <path d={WHISKERS} fill="none" stroke="var(--logo-tile)" strokeWidth={WHISKER_W} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

/** A block type's bullet: a disc in the type's line colour holding its icon. */
export function TypeTile({ type, size }: { type: BlockType; size?: 'sm' | 'lg' }) {
  const m = BLOCK_META[type];
  const Icon = m.icon;
  return <span className={`tile t-${type} ${size ?? ''}`} style={{ '--tc': m.color } as CSSProperties} title={m.name}><Icon strokeWidth={2.4} /></span>;
}

export function PageHeader({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div className="titles">
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, children, actions, small }: {
  icon: LucideIcon; title: ReactNode; children?: ReactNode; actions?: ReactNode; small?: boolean;
}) {
  return (
    <div className={`empty ${small ? 'sm' : ''}`}>
      <div className="ic"><Icon size={20} strokeWidth={1.8} /></div>
      <div className="t1">{title}</div>
      {children && <div className="t2">{children}</div>}
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function ErrorCard({ children }: { children: ReactNode }) {
  return <div className="error-card"><CircleAlert size={15} /><div>{children}</div></div>;
}

/** Shimmering placeholder rows for tables/lists while loading. */
export function SkeletonRows({ rows = 6, cols = [80, 220, 140, 100, 60] }: { rows?: number; cols?: number[] }) {
  return (
    <div className="table-wrap skel-rows" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="skel-row">
          {cols.map((w, c) => <div key={c} className="skel" style={{ width: w * (0.7 + ((r * 7 + c * 3) % 5) / 10) }} />)}
        </div>
      ))}
    </div>
  );
}

const SEV_ICON: Record<Severity, LucideIcon> = { must_fix: OctagonAlert, consider: TriangleAlert, minor: Info };
export function SevBadge({ sev }: { sev: Severity }) {
  const Icon = SEV_ICON[sev];
  return <span className={`sev ${sev}`}><Icon strokeWidth={2.2} />{SEVERITY_LABEL[sev]}</span>;
}

const TRIGGER_ICON: Record<TriggerKind, LucideIcon> = {
  'pre-commit': GitCommitHorizontal, 'pre-push': Upload, 'post-push': CircleArrowUp, manual: Hand,
};
export function triggerIcon(t: string): LucideIcon { return TRIGGER_ICON[t as TriggerKind] ?? Hand; }
export function TriggerLabel({ trigger }: { trigger: string }) {
  const Icon = triggerIcon(trigger);
  return <span className="trig"><Icon />{trigger}</span>;
}

/** Render `backtick` spans in model-written prose as inline code; everything else stays plain text. */
export function InlineCode({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]+`)/g);
  return <>{parts.map((p, i) => (p.length > 2 && p.startsWith('`') && p.endsWith('`') ? <code key={i} className="ic-code">{p.slice(1, -1)}</code> : p))}</>;
}
