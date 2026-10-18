// Bundle Monaco locally (the default loader fetches it from a CDN, which an offline IDE can't rely on).
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { THEMES } from '../shared/themes';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new JsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};

// One editor theme per app theme, from the brand book colors (Monaco needs hex values).
for (const { id, dark, colors } of THEMES) {
  monaco.editor.defineTheme(`mooch-${id}`, {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': colors.bg,
      'editorGutter.background': colors.bg,
      'editorLineNumber.foreground': colors.muted + '99',
      'editorLineNumber.activeForeground': colors.muted,
      'editor.selectionBackground': colors.tint,
      'editor.lineHighlightBackground': colors.panel,
      'editorCursor.foreground': colors.accent,
      'editorWidget.background': colors.surface,
      'editorWidget.border': colors.border,
      'scrollbarSlider.background': colors.border + '80',
      'editorOverviewRuler.border': '#00000000',
    },
  });
}

loader.config({ monaco });
