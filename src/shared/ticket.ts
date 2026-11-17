import * as fs from 'node:fs';
import * as path from 'node:path';

/** Things that look like ticket keys and are not. */
const IGNORED_PREFIXES = new Set([
  'UTF', 'ISO', 'SHA', 'GPT', 'HTTP', 'HTTPS', 'RFC', 'COVID', 'MD', 'AES', 'RSA', 'CVE', 'ES', 'TLS', 'SSL',
  'IPV', 'UTC', 'GMT', 'PHP', 'CSS', 'HTML', 'WCAG', 'ISBN', 'BASE', 'FIX', 'BUG', 'ISSUE', 'RELEASE',
  'VERSION', 'HOTFIX', 'FEATURE', 'PR', 'STEP', 'PHASE', 'PART', 'TOP', 'VER', 'REV', 'TASK', 'TEST', 'PATCH',
]);

/**
 * Finds a ticket key such as SHOP-123. Branch names are matched in any case
 * (feature/shop-123-foo); prompts only as typed in capitals, so "step-2" in a
 * sentence is not a ticket.
 */
export function detectTicket(text: string | null, opts: { anyCase: boolean; prefixes: string[] }): string | null {
  if (!text) return null;
  const allowed = new Set(opts.prefixes.map((p) => p.toUpperCase()));
  const pattern = new RegExp('(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9})-(\\d{1,6})(?![A-Za-z0-9])', opts.anyCase ? 'gi' : 'g');
  for (const match of text.slice(0, 4000).matchAll(pattern)) {
    if (!opts.anyCase && match[1] !== match[1].toUpperCase()) continue;
    const prefix = match[1].toUpperCase();
    if (allowed.size ? !allowed.has(prefix) : IGNORED_PREFIXES.has(prefix)) continue;
    return `${prefix}-${match[2]}`;
  }
  return null;
}

/** Current branch, read straight from .git so no process is spawned. */
export function readBranch(projectPath: string): string | null {
  try {
    let dir = projectPath;
    for (let depth = 0; depth < 6; depth++) {
      const dotGit = path.join(dir, '.git');
      if (fs.existsSync(dotGit)) {
        let gitDir = dotGit;
        if (fs.statSync(dotGit).isFile()) {
          // Worktrees and submodules: ".git" is a file pointing at the real directory.
          const pointer = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
          if (!pointer) return null;
          gitDir = path.resolve(dir, pointer[1].trim());
        }
        const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
        const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
        return ref ? ref[1] : null;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through
  }
  return null;
}
