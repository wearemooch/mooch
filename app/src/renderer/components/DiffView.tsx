// Renders a unified diff as Codex reports it in fileChange items.
export function DiffView({ diff, compact = false }: { diff: string; compact?: boolean }) {
  const lines = diff.replace(/\n$/, '').split('\n');
  return (
    <pre className={`diff${compact ? ' compact' : ''}`}>
      {lines.map((line, index) => {
        const kind = line.startsWith('@@')
          ? 'hunk'
          : line.startsWith('+++') || line.startsWith('---')
            ? 'meta'
            : line.startsWith('+')
              ? 'add'
              : line.startsWith('-')
                ? 'del'
                : 'ctx';
        return (
          <span key={index} className={`diff-line ${kind}`}>
            {line || ' '}
            {'\n'}
          </span>
        );
      })}
    </pre>
  );
}
