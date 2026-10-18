import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { extractZip, parseGitHubUrl, parseSkillMd, SkillManager } from './skills';

const SKILL = (name: string, description = 'Does a thing.') => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nInstructions.\n`;

function makeSkill(root: string, name: string, extra: Record<string, string> = {}) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), SKILL(name));
  for (const [file, content] of Object.entries(extra)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

describe('parseSkillMd', () => {
  it('reads plain, quoted and folded frontmatter', () => {
    expect(parseSkillMd(SKILL('pdf', 'Read PDFs.'))).toEqual({ name: 'pdf', description: 'Read PDFs.' });
    expect(parseSkillMd('---\nname: "brand"\ndescription: "Brand voice: tone, words."\n---\nx')).toEqual({ name: 'brand', description: 'Brand voice: tone, words.' });
    expect(parseSkillMd('---\nname: long\ndescription: >\n  First line\n  second line\nlicense: MIT\n---\n')).toEqual({ name: 'long', description: 'First line second line' });
    expect(parseSkillMd('# no frontmatter')).toBeUndefined();
    expect(parseSkillMd('---\nname: x\n---\n')).toBeUndefined();
  });
});

describe('parseGitHubUrl', () => {
  it('accepts repo, tree and blob links on github.com only', () => {
    expect(parseGitHubUrl('https://github.com/anthropics/skills')).toEqual({ owner: 'anthropics', repo: 'skills', ref: undefined, subdir: '' });
    expect(parseGitHubUrl('https://github.com/anthropics/skills/tree/main/document-skills/pdf')).toEqual({ owner: 'anthropics', repo: 'skills', ref: 'main', subdir: 'document-skills/pdf' });
    expect(parseGitHubUrl('https://github.com/o/r/blob/main/skills/x/SKILL.md')?.subdir).toBe('skills/x');
    expect(parseGitHubUrl('http://github.com/o/r')).toBeUndefined();
    expect(parseGitHubUrl('https://evil.com/o/r')).toBeUndefined();
    expect(parseGitHubUrl('https://github.com/o/r/tree/main/../../etc')).toBeUndefined();
    expect(parseGitHubUrl('not a url')).toBeUndefined();
  });
});

describe('extractZip', () => {
  it('refuses entries that would escape the target folder', () => {
    const target = mkdtempSync(path.join(tmpdir(), 'mooch-zip-'));
    expect(() => extractZip(zipSync({ '../evil.txt': strToU8('x') }), target)).toThrow(/unsafe path/);
    expect(existsSync(path.join(target, '..', 'evil.txt'))).toBe(false);
    extractZip(zipSync({ 'a/SKILL.md': strToU8(SKILL('a')) }), target);
    expect(readFileSync(path.join(target, 'a', 'SKILL.md'), 'utf8')).toContain('name: a');
  });
});

describe('SkillManager', () => {
  it('installs from a folder, keeps or replaces existing skills, lists and removes', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mooch-skills-'));
    const manager = new SkillManager(path.join(root, 'installed'), root);
    const source = makeSkill(path.join(root, 'src'), 'greeter', { 'scripts/run.sh': 'echo hi' });
    const prep = await manager.prepare({ kind: 'folder', path: source });
    expect(prep.candidates).toMatchObject([{ name: 'greeter', hasScripts: true, exists: false, fileCount: 2 }]);
    expect(manager.install(prep.token, ['greeter'], false)).toEqual(['greeter']);
    expect(manager.list().map((s) => s.name)).toEqual(['greeter']);

    const again = await manager.prepare({ kind: 'folder', path: source });
    expect(again.candidates[0].exists).toBe(true);
    expect(manager.install(again.token, ['greeter'], false)).toEqual([]); // kept
    const third = await manager.prepare({ kind: 'folder', path: source });
    expect(manager.install(third.token, ['greeter'], true)).toEqual(['greeter']); // replaced
    expect(() => manager.install(third.token, ['greeter'], true)).toThrow(/expired/);

    manager.remove('greeter');
    expect(manager.list()).toEqual([]);
    expect(() => manager.remove('../x')).toThrow();
  });

  it('finds several skills in a .zip and imports from other apps', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mooch-skills-'));
    const zipFile = path.join(root, 'pack.zip');
    writeFileSync(zipFile, zipSync({ 'pack/one/SKILL.md': strToU8(SKILL('one')), 'pack/two/SKILL.md': strToU8(SKILL('two')), 'pack/README.md': strToU8('x') }));
    const manager = new SkillManager(path.join(root, 'installed'), root);
    const prep = await manager.prepare({ kind: 'zip', path: zipFile });
    expect(prep.candidates.map((c) => c.name).sort()).toEqual(['one', 'two']);
    manager.install(prep.token, ['two'], false);
    expect(manager.list().map((s) => s.name)).toEqual(['two']);

    makeSkill(path.join(root, '.claude', 'skills'), 'from-claude');
    const imported = await manager.prepare({ kind: 'import' });
    expect(imported.candidates.map((c) => c.name)).toContain('from-claude');
  });

  it('lists a project skill over a user skill of the same name, and rejects folders without a skill', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mooch-skills-'));
    const manager = new SkillManager(path.join(root, 'installed'), root);
    makeSkill(path.join(root, 'installed'), 'shared');
    makeSkill(path.join(root, 'proj', '.mooch', 'skills'), 'shared');
    expect(manager.list(path.join(root, 'proj'))).toMatchObject([{ name: 'shared', scope: 'project' }]);
    mkdirSync(path.join(root, 'empty'));
    await expect(manager.prepare({ kind: 'folder', path: path.join(root, 'empty') })).rejects.toThrow(/No skill found/);
  });

  it('does not copy symbolic links out of a skill', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mooch-skills-'));
    const source = makeSkill(path.join(root, 'src'), 'linky');
    try {
      symlinkSync(path.join(root, 'outside'), path.join(source, 'link'), 'junction');
    } catch {
      return; // creating links needs extra rights on some Windows setups
    }
    const manager = new SkillManager(path.join(root, 'installed'), root);
    const prep = await manager.prepare({ kind: 'folder', path: source });
    manager.install(prep.token, ['linky'], false);
    expect(existsSync(path.join(root, 'installed', 'linky', 'link'))).toBe(false);
  });
});
