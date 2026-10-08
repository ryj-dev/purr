// The PR material that context prompts can include: changed-file list, diff, full files within a budget, CLAUDE.md.
import type { Finding, Run } from '../../shared/types.ts';
import { type ChangeSpec, type ChangedFile, fileAt, unifiedDiff } from '../git.ts';
import { truncate } from '../util.ts';
import { slim } from './findings.ts';

const SKIP_FILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|uv\.lock|poetry\.lock|Cargo\.lock|go\.sum|Gemfile\.lock)$|\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|eot|mp4|mov|min\.js|map)$/i;

export class Material {
  change: ChangeSpec;
  files: ChangedFile[];
  run: Run;
  private diffCache: string | null = null;
  private contents = new Map<string, string | null>();
  constructor(change: ChangeSpec, files: ChangedFile[], run: Run) {
    this.change = change; this.files = files; this.run = run;
  }

  async diff(): Promise<string> {
    if (this.diffCache === null) this.diffCache = await unifiedDiff(this.change);
    return this.diffCache;
  }
  async content(path: string): Promise<string | null> {
    if (!this.contents.has(path)) this.contents.set(path, await fileAt(this.change, path));
    return this.contents.get(path)!;
  }

  changedFiles(): string {
    if (!this.files.length) return '(no changes)';
    const st = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' } as const;
    return this.files.map((f) => `${st[f.status]} ${f.oldPath ? `${f.oldPath} -> ` : ''}${f.path} (+${f.additions} -${f.deletions})`).join('\n');
  }

  /** Diff plus full post-change files (line-numbered) until `budget` chars; lists what didn't fit. */
  async diffAndFiles(includeDiff: boolean, includeFiles: boolean, budget: number): Promise<{ diff: string; files: string }> {
    const d = includeDiff ? await this.diff() : '';
    const diffText = includeDiff ? '```diff\n' + truncate(d, budget) + '\n```' : '(not included; use git diff to see it)';
    let left = budget - d.length;
    if (!includeFiles) return { diff: diffText, files: '' };
    const parts: string[] = [], omitted: string[] = [];
    for (const f of this.files.slice(0, 80)) {
      if (f.status === 'deleted' || f.binary || SKIP_FILE.test(f.path)) continue;
      const c = await this.content(f.path);
      if (c === null) continue;
      const numbered = c.split('\n').map((l, i) => `${String(i + 1).padStart(5)}  ${l}`).join('\n');
      if (numbered.length + 50 > left) { omitted.push(f.path); continue; }
      parts.push(`### ${f.path}\n\`\`\`\n${numbered}\n\`\`\``);
      left -= numbered.length + 50;
    }
    let files = parts.length ? `\nFull contents of changed files at the reviewed revision (line-numbered):\n\n${parts.join('\n\n')}` : '';
    if (omitted.length) files += `\n\nOmitted for size (read them with the tools): ${omitted.join(', ')}`;
    return { diff: diffText, files };
  }

  async claudeMd(): Promise<string> {
    const c = await fileAt(this.change, 'CLAUDE.md');
    return c ? truncate(c, 12_000) : '(none)';
  }

  async vars(opts: { includeDiff: boolean; includeFiles: boolean; budgetChars: number }, upstream: { findings: Finding[]; texts: string[] }) {
    const { diff, files } = await this.diffAndFiles(opts.includeDiff, opts.includeFiles, opts.budgetChars);
    const scannerFindings = upstream.findings.filter((f) => f.source.kind === 'scanner');
    return {
      pr_title: this.run.pr?.title || '(no PR: local change)',
      pr_body: this.run.pr?.body ? truncate(this.run.pr.body, 4000) : '(none)',
      branch: this.run.branch ?? '(detached)',
      base: this.change.mode === 'staged' ? 'HEAD' : (this.change.base ?? '(root)'),
      head: this.change.mode === 'staged' ? 'staged changes (index)' : (this.change.head ?? 'HEAD'),
      changed_files: this.changedFiles(),
      diff,
      files,
      claude_md: await this.claudeMd(),
      scanner_findings: scannerFindings.length ? JSON.stringify(scannerFindings.map(slim), null, 1) : '(no scanner hits)',
      command_outputs: upstream.texts.length ? upstream.texts.join('\n\n') : '(none)',
      findings: JSON.stringify(upstream.findings.map(slim), null, 1),
    };
  }
}
