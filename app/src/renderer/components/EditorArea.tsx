import Editor, { type OnMount } from '@monaco-editor/react';
import { GitDiff, X } from '@phosphor-icons/react';
import { AGENT_NAME } from '../../shared/brand';
import { useRef } from 'react';
import { fileIcon } from '../fileIcons';
import { useApp } from '../store';
import { DiffView } from './DiffView';

export function EditorArea() {
  const tabs = useApp((s) => s.tabs);
  const activeTab = useApp((s) => s.activeTab);
  const closeTab = useApp((s) => s.closeTab);
  const editTab = useApp((s) => s.editTab);
  const saveTab = useApp((s) => s.saveTab);
  const theme = useApp((s) => s.theme);
  const active = tabs.find((tab) => tab.id === activeTab);
  const activeRef = useRef(activeTab);
  activeRef.current = activeTab;

  const onMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (activeRef.current) void saveTab(activeRef.current);
    });
  };

  if (!tabs.length) {
    return (
      <section className="editor empty">
        <p>Open a file from the tree, or tell {AGENT_NAME} what to change.</p>
      </section>
    );
  }

  return (
    <section className="editor">
      <div className="tabs" role="tablist">
        {tabs.map((tab) => {
          const dirty = tab.kind === 'file' && tab.content !== tab.saved;
          return (
            <div key={tab.id} className={`tab${tab.id === activeTab ? ' active' : ''}`} role="tab" aria-selected={tab.id === activeTab}>
              <button className="tab-label" onClick={() => useApp.setState({ activeTab: tab.id })} title={tab.path}>
                {tab.kind === 'diff' ? <GitDiff size={14} className="tab-icon" /> : <img className="tab-icon" src={fileIcon(tab.title, !theme.dark)} alt="" draggable={false} />}
                {tab.title}
                {dirty && <span className="dirty" aria-label="unsaved"> ●</span>}
              </button>
              <button className="tab-close" onClick={() => closeTab(tab.id)} aria-label={`Close ${tab.title}`}>
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="editor-body">
        {active?.kind === 'file' && (
          <Editor
            key={active.id}
            path={active.path}
            value={active.content}
            theme={`mooch-${theme.id}`}
            onMount={onMount}
            onChange={(value) => editTab(active.id, value ?? '')}
            options={{ minimap: { enabled: false }, fontSize: 13, fontFamily: "'JetBrains Mono', Consolas, monospace", fontLigatures: false, scrollBeyondLastLine: false, automaticLayout: true }}
          />
        )}
        {active?.kind === 'diff' && (
          <div className="diff-tab">
            <div className="diff-tab-head">
              <span>{active.path}</span>
              <button className="btn" onClick={() => void useApp.getState().openFile(active.path)}>
                Open file
              </button>
            </div>
            <DiffView diff={active.diff} />
          </div>
        )}
      </div>
    </section>
  );
}
