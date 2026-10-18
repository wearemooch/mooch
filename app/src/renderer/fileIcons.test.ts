import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileIconName, folderIconName, ICON_NAMES } from './fileIcons';

describe('file-tree icons', () => {
  it('has every mapped icon copied into fileIcons/', () => {
    const missing = ICON_NAMES.filter((name) => !existsSync(path.join(__dirname, 'fileIcons', `${name}.svg`)));
    expect(missing).toEqual([]);
  });

  it('picks icons by name, then pattern, then extension', () => {
    expect(fileIconName('package.json')).toBe('nodejs');
    expect(fileIconName('README.md')).toBe('readme');
    expect(fileIconName('tsconfig.web.json')).toBe('tsconfig');
    expect(fileIconName('index.d.ts')).toBe('typescript-def');
    expect(fileIconName('App.TSX')).toBe('react_ts');
    expect(fileIconName('proxy.js')).toBe('javascript');
    expect(fileIconName('.env.local')).toBe('tune');
    expect(fileIconName('project-id')).toBe('file');
    expect(fileIconName('notes.weird')).toBe('file');
  });

  it('gives known folders their own icon, open and closed', () => {
    expect(folderIconName('src', false)).toBe('folder-src');
    expect(folderIconName('node_modules', true)).toBe('folder-node-open');
    expect(folderIconName('.freebuff', false)).toBe('folder');
  });
});
