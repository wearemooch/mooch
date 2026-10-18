// The chat's entries: messages, the agent's work (folded into blocks), cards for commands, edits,
// approvals and the team features. Shared by Penny's panel and the session browser's preview.
import { ArrowsInLineVertical, PlugsConnected, CheckCircle, GitDiff, HourglassMedium, Info, PencilSimpleLine, Warning, XCircle } from '@phosphor-icons/react';
import { AGENT_NAME } from '../../shared/brand';
import { useApp } from '../store';
import { displayCommand, groupForDisplay, isMissingKeyError, workSummary, type Entry, type TranscriptState } from '../transcript';
import { Collapsible } from './Collapsible';
import { DiffView } from './DiffView';
import { Markdown } from './Markdown';
import { CouncilCard, RaceCard, ReviewCard } from './TeamCards';
import { RestoredCard, RestorePointRow } from './RestorePoints';
import { McpApproval } from './McpCards';

function EntryView({ entry }: { entry: Entry }) {
  const answer = useApp((s) => s.answer);
  const openDiff = useApp((s) => s.openDiff);

  switch (entry.type) {
    case 'user':
      return <div className="msg user">{entry.text}</div>;
    case 'agent':
      return (
        <div className="msg agent">
          <div className="msg-author">{AGENT_NAME}</div>
          {entry.text ? <Markdown text={entry.text} /> : '…'}
        </div>
      );
    case 'reasoning':
      return entry.text ? (
        <Collapsible title={<span className="muted">{entry.done ? 'Thought' : 'Thinking…'}</span>}>
          <div className="reasoning">{entry.text}</div>
        </Collapsible>
      ) : null;
    case 'command': {
      const failed = entry.status === 'failed' || (entry.exitCode !== null && entry.exitCode !== 0);
      const state = entry.status === 'inProgress' ? 'running' : entry.status === 'declined' ? 'declined' : failed ? `exit ${entry.exitCode}` : 'ok';
      return (
        <div className={`card command ${failed ? 'failed' : ''}`}>
          <Collapsible
            open={entry.status === 'inProgress'}
            title={
              <>
                <code className="cmd" title={entry.command}>
                  $ {displayCommand(entry.command)}
                </code>
                <span className={`badge ${state === 'ok' ? 'ok' : state === 'running' ? 'busy' : 'bad'}`}>{state}</span>
              </>
            }
          >
            <pre className="output">{entry.output || '(no output)'}</pre>
          </Collapsible>
        </div>
      );
    }
    case 'fileChange':
      return (
        <div className="card files">
          <div className="card-title">
            <PencilSimpleLine size={14} />
            Edited {entry.changes.length} file{entry.changes.length === 1 ? '' : 's'}
            <span className={`badge ${entry.status === 'completed' ? 'ok' : entry.status === 'inProgress' ? 'busy' : 'bad'}`}>{entry.status}</span>
          </div>
          {entry.changes.map((change) => (
            <Collapsible
              key={change.path}
              title={
                <>
                  <span className={`kind ${change.kind.type}`}>{change.kind.type}</span> {change.path}
                </>
              }
            >
              <DiffView diff={change.diff} compact />
              <button className="btn small" onClick={() => openDiff(change.path, change.diff)}>
                <GitDiff size={14} />
                Open in editor
              </button>
            </Collapsible>
          ))}
        </div>
      );
    case 'plan':
      return <div className="card plan">{entry.text}</div>;
    case 'tool':
      if (entry.integration) {
        return (
          <div className={`card tool${entry.status === 'failed' ? ' failed' : ''}`}>
            <Collapsible
              title={
                <>
                  <PlugsConnected size={14} />
                  <span className="mono small">{entry.title}</span>
                  <span className={`badge ${entry.status === 'completed' ? 'ok' : entry.status === 'inProgress' ? 'busy' : 'bad'}`}>{entry.status === 'inProgress' ? 'running' : entry.status}</span>
                </>
              }
            >
              {entry.args && <pre className="output">{entry.args}</pre>}
              {entry.result && <pre className="output">{entry.result}</pre>}
            </Collapsible>
          </div>
        );
      }
      return (
        <div className="card tool">
          {entry.title} <span className="badge">{entry.status}</span>
        </div>
      );
    case 'approval': {
      const { request } = entry;
      // Once answered, the command or file card already shows what happened.
      if (entry.resolved) return null;
      if (request.type.startsWith('mcp')) return <McpApproval request={request} />;
      return (
        <div className="card approval">
          <div className="card-title">{request.type === 'command' ? 'Run this command?' : 'Apply these file changes?'}</div>
          {request.command && <code className="cmd block">$ {displayCommand(request.command)}</code>}
          {request.reason && <p className="muted">{request.reason}</p>}
          <div className="actions">
            <button className="btn primary" onClick={() => void answer(request.requestId, 'accept')}>
              <CheckCircle />
              Approve
            </button>
            <button className="btn" onClick={() => void answer(request.requestId, 'acceptForSession')}>
              Always this session
            </button>
            <button className="btn" onClick={() => void answer(request.requestId, 'decline')}>
              <XCircle />
              Deny
            </button>
          </div>
        </div>
      );
    }
    case 'council':
      return <CouncilCard council={entry.council} />;
    case 'review':
      return <ReviewCard review={entry.review} />;
    case 'race':
      return <RaceCard race={entry.race} />;
    case 'point':
      return <RestorePointRow point={entry.point} />;
    case 'restored':
      return <RestoredCard entryId={entry.id} result={entry.result} undone={entry.undone} />;
    case 'note':
      return (
        <div className="transcript-note">
          <HourglassMedium size={13} />
          {entry.text}
        </div>
      );
    case 'info':
      return (
        <div className="card info">
          <Info size={15} />
          <Markdown text={entry.text} />
        </div>
      );
    case 'compaction':
      return (
        <div className="compaction" role="separator">
          <ArrowsInLineVertical size={13} />
          {entry.done ? `Chat compacted: ${AGENT_NAME} continues from a summary of everything above` : 'Compacting the chat…'}
        </div>
      );
    case 'error':
      return (
        <div className="card error">
          <div className="with-icon top">
            <Warning size={15} />
            <span>{entry.text}</span>
          </div>
          {isMissingKeyError(entry.text) && (
            <button className="btn small" onClick={() => useApp.getState().setSettingsPage('providers')}>
              Add a free key
            </button>
          )}
        </div>
      );
  }
}

/**
 * The agent's thinking, commands and tool calls between two messages, in one block: open while the
 * agent is working on it, folded to a one-line summary when the step is done. The user's own toggle wins.
 */
function WorkBlock({ entries, live }: { entries: Entry[]; live: boolean }) {
  const summary = workSummary(entries);
  return (
    <div className={`work${live ? ' live' : ''}`}>
      <Collapsible open={live} title={<span className="work-title">{live ? `Working… · ${summary.toLowerCase()}` : summary}</span>}>
        <div className="work-body">
          {entries.map((entry) =>
            entry.type === 'reasoning' ? (
              entry.text ? (
                <div key={entry.id} className="reasoning">
                  {entry.text}
                </div>
              ) : null
            ) : (
              <EntryView key={entry.id} entry={entry} />
            ),
          )}
        </div>
      </Collapsible>
    </div>
  );
}

/** Every entry of a transcript, with the agent's work between messages folded into blocks. */
export function TranscriptEntries({ transcript }: { transcript: TranscriptState }) {
  return (
    <>
      {groupForDisplay(transcript.entries).map((item, index, items) =>
        item.kind === 'work' ? (
          // Live while the turn runs and nothing but pending prompts follows it.
          <WorkBlock key={item.id} entries={item.entries} live={transcript.running && items.slice(index + 1).every((i) => i.kind === 'entry' && i.entry.type === 'approval')} />
        ) : (
          <EntryView key={item.entry.id} entry={item.entry} />
        ),
      )}
    </>
  );
}
