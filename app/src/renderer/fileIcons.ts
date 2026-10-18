// File-tree icons: Material Icon Theme SVGs (MIT), used in the tree and editor tabs only (brand book v2).
// The SVGs are copied into ./fileIcons by scripts/file-icons.mjs; this file maps names to them.

const urls = import.meta.glob<string>('./fileIcons/*.svg', { eager: true, query: '?url', import: 'default' });

function url(name: string, light: boolean): string {
  return (light && urls[`./fileIcons/${name}_light.svg`]) || urls[`./fileIcons/${name}.svg`] || urls['./fileIcons/file.svg'];
}

/** Whole file names (lowercase) with their own icon. */
const FILE_NAMES: Record<string, string> = {
  'package.json': 'nodejs',
  'package-lock.json': 'lock',
  'yarn.lock': 'lock',
  'pnpm-lock.yaml': 'lock',
  'bun.lockb': 'lock',
  'cargo.lock': 'lock',
  'poetry.lock': 'lock',
  'uv.lock': 'lock',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  '.npmrc': 'npm',
  '.npmignore': 'npm',
  dockerfile: 'docker',
  '.dockerignore': 'docker',
  'docker-compose.yml': 'docker',
  'docker-compose.yaml': 'docker',
  '.prettierrc': 'prettier',
  '.babelrc': 'babel',
  '.editorconfig': 'settings',
  makefile: 'settings',
};

/** File-name patterns, checked in order before extensions. */
const FILE_PATTERNS: [RegExp, string][] = [
  [/^readme(\.|$)/, 'readme'],
  [/^(license|licence|copying)(\.|$)/, 'license'],
  [/^\.env(\.|$)/, 'tune'],
  [/^tsconfig(\..*)?\.json$/, 'tsconfig'],
  [/^vite\.config\./, 'vite'],
  [/^vitest\.config\./, 'vitest'],
  [/^jest\.config\./, 'jest'],
  [/^(\.eslintrc|eslint\.config\.)/, 'eslint'],
  [/^(\.prettierrc|prettier\.config\.)/, 'prettier'],
  [/^(babel\.config\.|\.babelrc)/, 'babel'],
  [/^tailwind\.config\./, 'tailwindcss'],
  [/^webpack\.config\./, 'webpack'],
  [/\.d\.ts$/, 'typescript-def'],
  [/\.lock$/, 'lock'],
];

const EXTENSIONS: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'react', tsx: 'react_ts',
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  json: 'json', jsonc: 'json', json5: 'json',
  md: 'markdown', mdx: 'markdown',
  html: 'html', htm: 'html',
  css: 'css', scss: 'sass', sass: 'sass', less: 'less',
  vue: 'vue', svelte: 'svelte',
  py: 'python', pyi: 'python', ipynb: 'python',
  rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', cs: 'csharp',
  php: 'php', rb: 'ruby', lua: 'lua',
  sh: 'console', bash: 'console', zsh: 'console', bat: 'console', cmd: 'console',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', xml: 'xml', ini: 'settings', cfg: 'settings', conf: 'settings',
  svg: 'svg',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', ico: 'image', bmp: 'image', avif: 'image',
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', flac: 'audio',
  zip: 'zip', tar: 'zip', gz: 'zip', tgz: 'zip', '7z': 'zip', rar: 'zip',
  pdf: 'pdf',
  ttf: 'font', otf: 'font', woff: 'font', woff2: 'font',
  exe: 'exe', dll: 'exe', msi: 'exe',
  log: 'log',
  txt: 'document', rtf: 'document',
  sql: 'database', db: 'database', sqlite: 'database',
  pem: 'key', key: 'key', crt: 'certificate', cer: 'certificate',
};

/** Folder names (lowercase) with their own icon; each has a matching "-open" variant. */
const FOLDERS: Record<string, string> = {
  src: 'folder-src', source: 'folder-src',
  lib: 'folder-lib', libs: 'folder-lib',
  app: 'folder-app',
  node_modules: 'folder-node',
  '.git': 'folder-git', '.github': 'folder-github', '.vscode': 'folder-vscode',
  test: 'folder-test', tests: 'folder-test', __tests__: 'folder-test', spec: 'folder-test', e2e: 'folder-test',
  dist: 'folder-dist', out: 'folder-dist', build: 'folder-dist', release: 'folder-dist',
  public: 'folder-public', static: 'folder-public',
  components: 'folder-components',
  scripts: 'folder-scripts', bin: 'folder-scripts',
  config: 'folder-config', configs: 'folder-config', '.config': 'folder-config', settings: 'folder-config',
  docs: 'folder-docs', doc: 'folder-docs',
  images: 'folder-images', img: 'folder-images', icons: 'folder-images', assets: 'folder-images',
  utils: 'folder-utils', helpers: 'folder-utils',
  styles: 'folder-css', css: 'folder-css',
  api: 'folder-api', server: 'folder-server', client: 'folder-client',
  hooks: 'folder-hook', layouts: 'folder-layout', views: 'folder-views', pages: 'folder-views', routes: 'folder-routes',
  database: 'folder-database', db: 'folder-database',
  logs: 'folder-log',
  types: 'folder-interface', interfaces: 'folder-interface',
  shared: 'folder-shared', core: 'folder-core', ui: 'folder-ui',
  packages: 'folder-packages', plugins: 'folder-plugin', themes: 'folder-theme',
  i18n: 'folder-i18n', locales: 'folder-i18n',
  mocks: 'folder-mock', __mocks__: 'folder-mock', fixtures: 'folder-mock',
  examples: 'folder-examples', coverage: 'folder-coverage', tmp: 'folder-temp', temp: 'folder-temp',
  tools: 'folder-tools', prompts: 'folder-prompts', middleware: 'folder-middleware',
  target: 'folder-target', docker: 'folder-docker', '.env': 'folder-environment', keys: 'folder-keys',
};

export function fileIconName(fileName: string): string {
  const name = fileName.toLowerCase();
  if (FILE_NAMES[name]) return FILE_NAMES[name];
  for (const [pattern, icon] of FILE_PATTERNS) if (pattern.test(name)) return icon;
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  return EXTENSIONS[ext] ?? 'file';
}

export function folderIconName(folderName: string, open: boolean): string {
  const base = FOLDERS[folderName.toLowerCase()] ?? 'folder';
  return open ? `${base}-open` : base;
}

export function fileIcon(fileName: string, light: boolean): string {
  return url(fileIconName(fileName), light);
}

export function folderIcon(folderName: string, open: boolean, light: boolean): string {
  return url(folderIconName(folderName, open), light);
}

/** Every icon name the maps above can produce, for the copy script and tests. */
export const ICON_NAMES: string[] = [
  ...new Set([
    'file',
    'folder',
    'folder-open',
    ...Object.values(FILE_NAMES),
    ...FILE_PATTERNS.map(([, icon]) => icon),
    ...Object.values(EXTENSIONS),
    ...Object.values(FOLDERS).flatMap((f) => [f, `${f}-open`]),
  ]),
];
