// A repository's own configuration can make "read-only" git commands run programs: core.fsmonitor
// runs on `git status`, diff.external and textconv drivers on `git diff`/`log -p`/`show`, filters on
// status. The command line looks harmless, so before a git command runs without asking, the
// repository's config files are checked for anything that runs a program or reads elsewhere.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** Keys that run a program, or point git at files outside the project, whatever section they are in. */
const RISKY_KEY = /(^|\])\s*(fsmonitor|external|textconv|pager|editor|sshcommand|askpass|hookspath|gitproxy|showsignature|program|worktree|excludesfile|attributesfile)\s*(=|$|[#;])/im;
/** Sections that pull in more config, define drivers, or set per-command pagers. */
const RISKY_SECTION = /^\s*\[\s*(include|includeif|filter|pager|diff\s+"|difftool|merge\s+")/im;

/** The repository's git directory for `root`: its own .git, or one found further up, as git would. */
export function findGitDir(root: string): string | undefined {
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, '.git');
    if (existsSync(dotGit)) {
      if (statSync(dotGit).isDirectory()) return dotGit;
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim();
      return pointer ? path.resolve(dir, pointer) : undefined;
    }
    if (path.dirname(dir) === dir) return undefined;
  }
}

function configFiles(gitDir: string): string[] {
  const files = [path.join(gitDir, 'config'), path.join(gitDir, 'config.worktree')];
  const commonDir = path.join(gitDir, 'commondir');
  if (existsSync(commonDir)) files.push(path.join(path.resolve(gitDir, readFileSync(commonDir, 'utf8').trim()), 'config'));
  // Submodules have their own config, which `git status` uses when it looks inside them.
  const modules = (dir: string, depth: number) => {
    if (depth > 3 || !existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const module = path.join(dir, entry.name);
      files.push(path.join(module, 'config'));
      modules(path.join(module, 'modules'), depth + 1);
    }
  };
  modules(path.join(gitDir, 'modules'), 0);
  return files.slice(0, 64);
}

/** True when the repository's own config could make a git read run a program (or can't be checked). */
export function gitConfigRunsPrograms(root: string): boolean {
  try {
    const gitDir = findGitDir(root);
    if (!gitDir) return false;
    return configFiles(gitDir).some((file) => {
      if (!existsSync(file)) return false;
      const text = readFileSync(file, 'utf8');
      return RISKY_KEY.test(text) || RISKY_SECTION.test(text);
    });
  } catch {
    return true;
  }
}
