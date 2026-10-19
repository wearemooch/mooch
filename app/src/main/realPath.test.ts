import { symlinkSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { linkedProject } from './linkedProject.fixture';
import { isReallyInside, realTarget } from './realPath';

describe('real containment', () => {
  it('accepts real paths inside, including ones that do not exist yet', () => {
    const { root } = linkedProject();
    expect(isReallyInside(root, 'src')).toBe(true);
    expect(isReallyInside(root, path.join(root, 'src', 'new', 'deep.txt'))).toBe(true);
    expect(isReallyInside(root, root)).toBe(true);
  });

  it('refuses paths that leave the project through a link', () => {
    const { root, outside } = linkedProject();
    expect(isReallyInside(root, 'link')).toBe(false);
    expect(isReallyInside(root, path.join('link', 'secret.txt'))).toBe(false);
    expect(isReallyInside(root, path.join('link', 'new-file.txt'))).toBe(false);
    expect(realTarget(path.join(root, 'link', 'x'))).toBe(path.join(realTarget(outside)!, 'x'));
  });

  it('refuses lexical escapes and dangling links', () => {
    const { root, base } = linkedProject();
    expect(isReallyInside(root, '../outside/secret.txt')).toBe(false);
    let dangling = true;
    try {
      symlinkSync(path.join(base, 'not-there'), path.join(root, 'dangling'), 'junction');
    } catch {
      dangling = false;
    }
    if (dangling) expect(isReallyInside(root, path.join('dangling', 'x.txt'))).toBe(false);
  });
});
