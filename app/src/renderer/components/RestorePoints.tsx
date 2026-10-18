// Restore points in the transcript: restore files (or rewind files + conversation) to before a message.
import { ArrowUUpLeft, ClockCounterClockwise } from '@phosphor-icons/react';
import { useState } from 'react';
import type { RestoreFile, RestorePoint, RestoreResult } from '../../shared/ipc';
import { api, errorMessage } from '../api';
import { useApp } from '../store';
import { Collapsible } from './Collapsible';

const ACTION_LABEL: Record<RestoreFile['action'], string> = { restore: 'restore', delete: 'delete', recreate: 'bring back' };

function FileList({ files }: { files: RestoreFile[] }) {
  if (!files.length) return <p className="muted">No files differ from this point.</p>;
  return (
    <ul className="team-list">
      {files.map((f) => (
        <li key={f.path}>
          <span className={`kind ${f.action === 'delete' ? 'delete' : f.action === 'recreate' ? 'add' : ''}`}>{ACTION_LABEL[f.action]}</span> {f.path}
        </li>
      ))}
    </ul>
  );
}

export function RestorePointRow({ point }: { point: RestorePoint }) {
  const restore = useApp((s) => s.restore);
  const running = useApp((s) => s.transcript.running);
  const [preview, setPreview] = useState<{ rewind: boolean; files?: RestoreFile[]; error?: string }>();
  const time = new Date(point.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const ask = async (rewind: boolean) => {
    setPreview({ rewind });
    try {
      setPreview({ rewind, files: await api.agent.previewRestore(point.id) });
    } catch (error) {
      setPreview({ rewind, error: errorMessage(error) });
    }
  };

  return (
    <div className="restore-point">
      <div className="restore-line">
        <span className="muted with-icon">
          <ClockCounterClockwise size={13} />
          Restore point · {time}
          {point.reason === 'race' && ' · before applying a race result'}
        </span>
        <span className="spacer" />
        <button className="link" disabled={running} onClick={() => void ask(false)} title="Put the files back to how they were here; keep the conversation">
          <ClockCounterClockwise size={13} />
          Restore files
        </button>
        {point.canRewind && (
          <button className="link" disabled={running} onClick={() => void ask(true)} title="Restore the files and remove this message and everything after it from the conversation">
            <ArrowUUpLeft size={13} />
            Rewind
          </button>
        )}
      </div>
      {preview && (
        <div className="card restore-confirm">
          <div className="card-title">{preview.rewind ? 'Rewind to before this message?' : 'Restore files to this point?'}</div>
          {preview.rewind && <p className="muted">The conversation from this message on is removed, and the message goes back in the input box.</p>}
          {preview.error && <p className="muted">{preview.error}</p>}
          {preview.files ? <FileList files={preview.files} /> : !preview.error && <p className="muted">Checking what would change…</p>}
          <p className="muted">You can undo this afterwards.</p>
          <div className="actions">
            <button
              className="btn primary small"
              disabled={!preview.files || (!preview.files.length && !preview.rewind)}
              onClick={() => {
                setPreview(undefined);
                void restore(point.id, preview.rewind);
              }}
            >
              {preview.rewind ? 'Rewind' : 'Restore'}
            </button>
            <button className="btn small" onClick={() => setPreview(undefined)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function RestoredCard({ entryId, result, undone }: { entryId: string; result: RestoreResult; undone?: boolean }) {
  const undoRestore = useApp((s) => s.undoRestore);
  const running = useApp((s) => s.transcript.running);
  const count = result.files.length;
  return (
    <div className="card team">
      <div className="card-title">
        {result.rewound ? 'Rewound' : 'Restored'} {count} file{count === 1 ? '' : 's'}
        {result.rewound && ' and the conversation'}
        {undone && <span className="badge">undone</span>}
      </div>
      {count > 0 && (
        <Collapsible title="Files">
          <FileList files={result.files} />
        </Collapsible>
      )}
      {!undone && count > 0 && (
        <button className="btn small" disabled={running} onClick={() => void undoRestore(entryId, result.undoPointId)}>
          Undo restore (files)
        </button>
      )}
    </div>
  );
}
