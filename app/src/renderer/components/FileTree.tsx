// The project's files: folders open in place, files open in the editor. Icons by file type (Material Icon
// Theme), indent guides, and the keyboard keys of a desktop file tree (arrows, Home/End, Enter).
import { ArrowClockwise, ArrowsInLineVertical, CaretRight } from '@phosphor-icons/react';
import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { create } from 'zustand';
import type { DirEntry } from '../../shared/ipc';
import { api } from '../api';
import { fileIcon, folderIcon } from '../fileIcons';
import { useApp } from '../store';

/** Which folders are open. Kept outside the components so it survives reloads of the listing. */
const useTree = create<{ open: Record<string, boolean>; toggle(path: string, open?: boolean): void; reveal(paths: string[]): void; collapseAll(): void }>((set) => ({
  open: {},
  toggle: (path, open) => set((s) => ({ open: { ...s.open, [path]: open ?? !s.open[path] } })),
  reveal: (paths) => set((s) => ({ open: { ...s.open, ...Object.fromEntries(paths.map((p) => [p, true])) } })),
  collapseAll: () => set({ open: {} }),
}));

/** Indentation per level; the guides line up with the caret column. */
const INDENT = 12;

function rowStyle(depth: number) {
  return { paddingLeft: 6 + depth * INDENT };
}

function Folder({ entry, depth }: { entry: DirEntry; depth: number }) {
  const open = useTree((s) => !!s.open[entry.path]);
  const toggle = useTree((s) => s.toggle);
  const light = useApp((s) => !s.theme.dark);
  return (
    <div role="none">
      <button
        className={`tree-row folder${entry.name.startsWith('.') ? ' dim' : ''}`}
        style={rowStyle(depth)}
        onClick={() => toggle(entry.path)}
        title={entry.path}
        role="treeitem"
        aria-expanded={open}
        aria-level={depth + 1}
        data-path={entry.path}
        data-folder=""
      >
        <CaretRight className={`tree-caret${open ? ' open' : ''}`} size={10} weight="bold" />
        <img className="tree-icon" src={folderIcon(entry.name, open, light)} alt="" draggable={false} />
        <span className="tree-name">{entry.name}</span>
      </button>
      {open && (
        <div className="tree-group" role="group" style={{ ['--guide' as string]: `${6 + depth * INDENT + 5}px` }}>
          <Children dir={entry.path} depth={depth + 1} />
        </div>
      )}
    </div>
  );
}

function Children({ dir, depth }: { dir: string; depth: number }) {
  const treeVersion = useApp((s) => s.treeVersion);
  const openFile = useApp((s) => s.openFile);
  const activeTab = useApp((s) => s.activeTab);
  const light = useApp((s) => !s.theme.dark);
  const [entries, setEntries] = useState<DirEntry[] | null>(null);

  const load = useCallback(() => {
    api.workspace.list(dir).then(setEntries, () => setEntries([]));
  }, [dir]);
  useEffect(load, [load, treeVersion]);

  if (!entries) return null;
  if (entries.length === 0) {
    return (
      <div className="tree-empty" style={rowStyle(depth)}>
        Empty folder
      </div>
    );
  }
  return (
    <>
      {entries.map((entry) =>
        entry.isDirectory ? (
          <Folder key={entry.path} entry={entry} depth={depth} />
        ) : (
          <button
            key={entry.path}
            className={`tree-row file${activeTab === `file:${entry.path}` ? ' active' : ''}${entry.name.startsWith('.') ? ' dim' : ''}`}
            style={rowStyle(depth)}
            onClick={() => void openFile(entry.path)}
            title={entry.path}
            role="treeitem"
            aria-level={depth + 1}
            aria-selected={activeTab === `file:${entry.path}`}
            data-path={entry.path}
          >
            <span className="tree-caret-space" />
            <img className="tree-icon" src={fileIcon(entry.name, light)} alt="" draggable={false} />
            <span className="tree-name">{entry.name}</span>
          </button>
        ),
      )}
    </>
  );
}

function parentOf(file: string): string {
  return file.replace(/[\\/][^\\/]+$/, '');
}

/** Arrow keys move between visible rows; Right/Left open, close, or step into and out of folders. */
function onTreeKey(event: KeyboardEvent<HTMLDivElement>) {
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.tree-row')];
  const current = document.activeElement as HTMLButtonElement | null;
  const index = current ? rows.indexOf(current) : -1;
  if (index < 0) return;
  const { open, toggle } = useTree.getState();
  const path = current!.dataset.path!;
  const isFolder = current!.dataset.folder !== undefined;
  const focus = (i: number) => rows[Math.max(0, Math.min(rows.length - 1, i))]?.focus();
  switch (event.key) {
    case 'ArrowDown':
      focus(index + 1);
      break;
    case 'ArrowUp':
      focus(index - 1);
      break;
    case 'Home':
      focus(0);
      break;
    case 'End':
      focus(rows.length - 1);
      break;
    case 'ArrowRight':
      if (isFolder && !open[path]) toggle(path, true);
      else if (isFolder) focus(index + 1);
      break;
    case 'ArrowLeft':
      if (isFolder && open[path]) toggle(path, false);
      else rows.find((row) => row.dataset.path === parentOf(path))?.focus();
      break;
    default:
      return;
  }
  event.preventDefault();
}

export function FileTree() {
  const workspace = useApp((s) => s.workspace);
  const activeTab = useApp((s) => s.activeTab);
  const collapseAll = useTree((s) => s.collapseAll);
  const reveal = useTree((s) => s.reveal);

  // Opening a file (from a chat card, say) opens the folders above it, so you can see where it lives.
  useEffect(() => {
    if (!workspace || !activeTab?.startsWith('file:')) return;
    const file = activeTab.slice('file:'.length);
    if (!file.toLowerCase().startsWith(workspace.toLowerCase())) return;
    const folders: string[] = [];
    for (let dir = parentOf(file); dir.length > workspace.length; dir = parentOf(dir)) folders.push(dir);
    if (folders.length) reveal(folders);
  }, [workspace, activeTab, reveal]);

  if (!workspace) return null;
  return (
    <nav className="tree" aria-label="Files">
      <div className="pane-title tree-title">
        <span className="tree-root" title={workspace}>
          {workspace.split(/[\\/]/).filter(Boolean).pop()}
        </span>
        <button className="icon-btn" onClick={() => useApp.setState((s) => ({ treeVersion: s.treeVersion + 1 }))} title="Refresh" aria-label="Refresh">
          <ArrowClockwise size={14} />
        </button>
        <button className="icon-btn" onClick={collapseAll} title="Collapse all folders" aria-label="Collapse all folders">
          <ArrowsInLineVertical size={14} />
        </button>
      </div>
      <div className="tree-scroll" role="tree" aria-label="Project files" onKeyDown={onTreeKey}>
        <Children dir={workspace} depth={0} />
      </div>
    </nav>
  );
}
