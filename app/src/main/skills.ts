// Skills: folders with a SKILL.md (name + description frontmatter, then instructions) and optional
// scripts or references, the format Claude and Codex use too. Installed skills live in ~/.mooch/skills;
// a project can add its own in .mooch/skills. Installing only copies files; nothing in a skill runs
// except through Penny's normal command approvals.
//
// Installing is two steps: prepare() unpacks a source (folder, .zip, GitHub URL, or other apps' skill
// folders) into a staging folder and describes what it found; install() copies the chosen skills over.
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import type { InstalledSkill, SkillCandidate, SkillPreparation } from '../shared/ipc';

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const MAX_ZIP_BYTES = 60 * 1024 * 1024;
const MAX_SKILL_FILES = 2_000;
const SCRIPT = /\.(sh|bash|zsh|ps1|psm1|bat|cmd|py|js|mjs|cjs|ts|rb|pl|exe)$/i;

/** Reads `name` and `description` from SKILL.md frontmatter. Quoted, plain and folded (`>`) values. */
export function parseSkillMd(text: string): { name: string; description: string } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return undefined;
  const lines = match[1].split(/\r?\n/);
  const value = (key: string): string | undefined => {
    const index = lines.findIndex((line) => line.startsWith(`${key}:`));
    if (index < 0) return undefined;
    let v = lines[index].slice(key.length + 1).trim();
    if (v === '>' || v === '|' || v === '>-' || v === '|-') {
      const block: string[] = [];
      for (const line of lines.slice(index + 1)) {
        if (!/^\s+\S/.test(line)) break;
        block.push(line.trim());
      }
      v = block.join(' ');
    }
    return v.replace(/^["']|["']$/g, '').trim();
  };
  const name = value('name');
  const description = value('description');
  return name && description ? { name, description } : undefined;
}

function listFiles(dir: string, base = dir, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (out.length > MAX_SKILL_FILES) break;
    if (entry.isSymbolicLink()) continue; // a link could point anywhere on the disk
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return out;
}

/** Skill folders under `root` (the root itself, or folders below it up to three levels down). */
export function findSkillDirs(root: string, depth = 3): string[] {
  if (existsSync(path.join(root, 'SKILL.md'))) return [root];
  if (depth === 0) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  return entries
    .filter((name) => !name.startsWith('.') && name !== 'node_modules')
    .map((name) => path.join(root, name))
    .filter((dir) => {
      try {
        return lstatSync(dir).isDirectory();
      } catch {
        return false;
      }
    })
    .flatMap((dir) => findSkillDirs(dir, depth - 1));
}

function describe(dir: string, installedDir: string): SkillCandidate | undefined {
  try {
    const meta = parseSkillMd(readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
    if (!meta || !NAME.test(meta.name)) return undefined;
    const files = listFiles(dir);
    return {
      name: meta.name,
      description: meta.description,
      source: dir,
      files: files.slice(0, 200),
      fileCount: files.length,
      hasScripts: files.some((f) => SCRIPT.test(f)),
      exists: existsSync(path.join(installedDir, meta.name)),
    };
  } catch {
    return undefined;
  }
}

/** `github.com/<owner>/<repo>[/tree/<ref>[/<path>]]` → its parts. */
export function parseGitHubUrl(url: string): { owner: string; repo: string; ref?: string; subdir: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' || !/^(www\.)?github\.com$/i.test(parsed.hostname)) return undefined;
  const parts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length < 2) return undefined;
  const [owner, rawRepo, kind, ref, ...rest] = parts;
  const repo = rawRepo.replace(/\.git$/, '');
  const safe = /^[\w.-]+$/;
  if (!safe.test(owner) || !safe.test(repo)) return undefined;
  if (kind && kind !== 'tree' && kind !== 'blob') return undefined;
  if (rest.some((p) => p === '..' || p === '.')) return undefined;
  const subdir = kind === 'blob' ? rest.slice(0, -1).join('/') : rest.join('/'); // a link to SKILL.md itself → its folder
  return { owner, repo, ref, subdir };
}

/** Writes a zip's files under `target`, refusing entries that would land outside it (zip-slip). */
export function extractZip(data: Uint8Array, target: string): void {
  const files = unzipSync(data, { filter: (file) => !file.name.endsWith('/') });
  const root = path.resolve(target);
  let count = 0;
  for (const [name, content] of Object.entries(files)) {
    if (++count > 20_000) throw new Error('The archive has too many files.');
    const destination = path.resolve(root, name);
    if (destination !== root && !destination.startsWith(root + path.sep)) throw new Error(`The archive contains an unsafe path: ${name}`);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(response.status === 404 ? 'That repository or branch was not found (private repositories are not supported).' : `GitHub answered ${response.status}.`);
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_ZIP_BYTES) throw new Error('That repository is too large to download for one skill.');
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.length > MAX_ZIP_BYTES) throw new Error('That repository is too large to download for one skill.');
  return data;
}

/** Where other apps keep skills, for "Import". */
export function otherAppSkillFolders(home = homedir()): { app: string; dir: string }[] {
  return [
    { app: 'Claude', dir: path.join(home, '.claude', 'skills') },
    { app: 'Codex', dir: path.join(home, '.codex', 'skills') },
    { app: 'Agents', dir: path.join(home, '.agents', 'skills') },
  ];
}

export type SkillSource = { kind: 'folder'; path: string } | { kind: 'zip'; path: string } | { kind: 'github'; url: string } | { kind: 'import' };

export class SkillManager {
  private readonly staged = new Map<string, { dir?: string; candidates: SkillCandidate[] }>();

  constructor(
    readonly skillsDir: string,
    private readonly home = homedir(),
  ) {}

  /** Installed skills, from ~/.mooch/skills and the project's .mooch/skills. */
  list(projectRoot?: string): InstalledSkill[] {
    const read = (root: string, scope: InstalledSkill['scope']) =>
      findSkillDirs(root, 1).flatMap((dir) => {
        const candidate = describe(dir, this.skillsDir);
        return candidate ? [{ name: candidate.name, description: candidate.description, path: path.join(dir, 'SKILL.md'), dir, scope, hasScripts: candidate.hasScripts }] : [];
      });
    const user = read(this.skillsDir, 'user');
    const project = projectRoot ? read(path.join(projectRoot, '.mooch', 'skills'), 'project') : [];
    return [...project, ...user.filter((u) => !project.some((p) => p.name === u.name))].sort((a, b) => a.name.localeCompare(b.name));
  }

  async prepare(source: SkillSource): Promise<SkillPreparation> {
    this.discardAll();
    let dir: string | undefined;
    let roots: string[];
    if (source.kind === 'folder') {
      if (!statSync(source.path).isDirectory()) throw new Error('Pick a folder.');
      roots = [source.path];
    } else if (source.kind === 'import') {
      roots = otherAppSkillFolders(this.home)
        .map((f) => f.dir)
        .filter((d) => existsSync(d));
      if (!roots.length) throw new Error('No skills found in ~/.claude/skills, ~/.codex/skills or ~/.agents/skills.');
    } else {
      dir = mkdtempSync(path.join(tmpdir(), 'mooch-skill-'));
      if (source.kind === 'zip') {
        if (statSync(source.path).size > MAX_ZIP_BYTES) throw new Error('That .zip is too large.');
        extractZip(readFileSync(source.path), dir);
        roots = [dir];
      } else {
        const gh = parseGitHubUrl(source.url);
        if (!gh) throw new Error('Paste a GitHub link like github.com/owner/repo/tree/main/skills/name.');
        const ref = gh.ref ? `refs/heads/${gh.ref}` : 'HEAD';
        let data: Uint8Array;
        try {
          data = await download(`https://codeload.github.com/${gh.owner}/${gh.repo}/zip/${ref}`);
        } catch (error) {
          // The ref may be a tag or a commit rather than a branch.
          if (!gh.ref) throw error;
          data = await download(`https://codeload.github.com/${gh.owner}/${gh.repo}/zip/${gh.ref}`);
        }
        extractZip(data, dir);
        // GitHub zips have one top folder, "<repo>-<ref>".
        const top = readdirSync(dir).find((name) => statSync(path.join(dir!, name)).isDirectory()) ?? '';
        const start = path.resolve(dir, top, gh.subdir);
        if (!start.startsWith(path.resolve(dir)) || !existsSync(start)) throw new Error(`"${gh.subdir}" was not found in that repository.`);
        roots = [start];
      }
    }
    const seen = new Set<string>();
    const candidates = roots
      .flatMap((root) => findSkillDirs(root))
      .flatMap((d) => describe(d, this.skillsDir) ?? [])
      .filter((c) => !seen.has(c.name) && seen.add(c.name));
    if (!candidates.length) {
      if (dir) rmSync(dir, { recursive: true, force: true });
      throw new Error('No skill found there: a skill is a folder with a SKILL.md that starts with name and description.');
    }
    const token = randomUUID();
    this.staged.set(token, { dir, candidates });
    return { token, candidates };
  }

  /** Copies the chosen skills from a prepared source. Existing skills are replaced only when `replace`. */
  install(token: string, names: string[], replace: boolean): string[] {
    const staged = this.staged.get(token);
    if (!staged) throw new Error('That install expired. Start it again.');
    const installed: string[] = [];
    mkdirSync(this.skillsDir, { recursive: true });
    for (const candidate of staged.candidates.filter((c) => names.includes(c.name))) {
      const target = path.join(this.skillsDir, candidate.name);
      if (existsSync(target)) {
        if (!replace) continue;
        rmSync(target, { recursive: true, force: true });
      }
      cpSync(candidate.source, target, { recursive: true, filter: (src) => !lstatSync(src).isSymbolicLink() });
      installed.push(candidate.name);
    }
    this.discard(token);
    return installed;
  }

  remove(name: string): void {
    if (!NAME.test(name)) throw new Error('Invalid skill name.');
    rmSync(path.join(this.skillsDir, name), { recursive: true, force: true });
  }

  discard(token: string): void {
    const staged = this.staged.get(token);
    if (staged?.dir) rmSync(staged.dir, { recursive: true, force: true });
    this.staged.delete(token);
  }

  private discardAll(): void {
    for (const token of [...this.staged.keys()]) this.discard(token);
  }
}
