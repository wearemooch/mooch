// Transcript cards for the multi-model features: plan council, second-model review, and races.
import { AGENT_NAME } from '../../shared/brand';
import type { ContestantState, CouncilState, RaceState, ReviewState } from '../../shared/ipc';
import { useApp } from '../store';
import { Collapsible } from './Collapsible';
import { Markdown } from './Markdown';

function shortModel(slug: string): string {
  const parts = slug.split('/');
  return parts.length > 2 ? `${parts.at(-1)} · ${parts[0]}` : slug;
}

function Badge({ status }: { status: string }) {
  const tone = ['done', 'approved', 'decided', 'applied'].includes(status)
    ? 'ok'
    : ['failed', 'changes', 'discarded'].includes(status)
      ? 'bad'
      : 'busy';
  return <span className={`badge ${tone}`}>{status}</span>;
}

export function CouncilCard({ council }: { council: CouncilState }) {
  const title = { planning: 'Planning council is thinking', judging: 'Merging the plans', done: 'Plan agreed', failed: 'No plan' }[council.phase];
  return (
    <div className="card team">
      <div className="card-title">
        {title} <Badge status={council.phase} />
      </div>
      <ul className="team-list">
        {council.planners.map((p) => (
          <li key={p.model}>
            <span>{shortModel(p.model)}</span> <Badge status={p.status} />
            {p.error && <span className="muted"> {p.error}</span>}
          </li>
        ))}
        {council.planners.filter((p) => p.status === 'done').length > 1 && (
          <li>
            <span className="muted">judge:</span> {shortModel(council.judge)}
          </li>
        )}
      </ul>
      {council.merged && (
        <Collapsible title="Show the plan">
          <div className="plan-text">
            <Markdown text={council.merged} />
          </div>
        </Collapsible>
      )}
      {council.error && <p className="muted">{council.error}</p>}
    </div>
  );
}

export function ReviewCard({ review }: { review: ReviewState }) {
  const title = {
    reviewing: `Second opinion from ${shortModel(review.model)}…`,
    approved: `${shortModel(review.model)} approved the changes`,
    changes: `${shortModel(review.model)} asked for fixes; ${AGENT_NAME} is making them`,
    comments: `${shortModel(review.model)} left comments (no clear verdict)`,
    failed: `Review by ${shortModel(review.model)} failed`,
  }[review.phase];
  return (
    <div className={`card team review-${review.phase}`}>
      <div className="card-title">
        {title} <Badge status={review.phase} />
      </div>
      {review.text && (
        <Collapsible title={review.phase === 'failed' ? 'Error' : 'Review'} open={review.phase === 'changes'}>
          <div className="plan-text">
            <Markdown text={review.text} />
          </div>
        </Collapsible>
      )}
    </div>
  );
}

function ContestantRow({ race, contestant }: { race: RaceState; contestant: ContestantState }) {
  const applyRace = useApp((s) => s.applyRace);
  const winner = race.winnerId === contestant.id;
  const canApply = race.phase === 'decided' && contestant.status === 'done' && contestant.changedFiles.length > 0;
  return (
    <div className={`contestant${winner ? ' winner' : ''}`}>
      <div className="card-title">
        {winner && <span aria-label="winner">★</span>} {shortModel(contestant.model)} <Badge status={contestant.status} />
        {contestant.test && <span className={`badge ${contestant.test.passed ? 'ok' : 'bad'}`}>tests {contestant.test.passed ? 'pass' : 'fail'}</span>}
        {contestant.changedFiles.length > 0 && (
          <span className="muted">
            {contestant.changedFiles.length} file{contestant.changedFiles.length === 1 ? '' : 's'}, {contestant.linesChanged} lines
          </span>
        )}
      </div>
      {contestant.error && <p className="muted">{contestant.error}</p>}
      {contestant.lastMessage && contestant.status !== 'failed' && <p className="muted clamp">{contestant.lastMessage}</p>}
      {contestant.test && (
        <Collapsible title="Test output">
          <pre className="output">{contestant.test.output || '(no output)'}</pre>
        </Collapsible>
      )}
      {contestant.changedFiles.length > 0 && (
        <Collapsible title="Changed files">
          <ul className="team-list">
            {contestant.changedFiles.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </Collapsible>
      )}
      {canApply && (
        <button className={`btn small${winner ? ' primary' : ''}`} onClick={() => void applyRace(race.id, contestant.id)}>
          Apply this one
        </button>
      )}
    </div>
  );
}

export function RaceCard({ race }: { race: RaceState }) {
  const discardRace = useApp((s) => s.discardRace);
  const title = {
    preparing: 'Setting up the race',
    running: 'Race in progress',
    testing: 'Running tests',
    decided: race.winnerId ? 'Race finished: pick the result to apply' : 'Race finished: no clear winner',
    applied: 'Applied the chosen result',
    discarded: 'Race discarded',
    failed: 'Race failed',
  }[race.phase];
  return (
    <div className="card team race">
      <div className="card-title">
        {title} <Badge status={race.phase} />
      </div>
      <p className="muted">{race.testCommand ? `Judged by: ${race.testCommand}` : 'No test command found, so the smallest finished change wins.'}</p>
      {race.error && <p className="muted">{race.error}</p>}
      {race.contestants.map((c) => (
        <ContestantRow key={c.id} race={race} contestant={c} />
      ))}
      {race.applied && (
        <p className="muted">
          Wrote {race.applied.written.length}, deleted {race.applied.deleted.length}
          {race.applied.skipped.length > 0 && `, skipped ${race.applied.skipped.length} you changed meanwhile (${race.applied.skipped.join(', ')})`}.
        </p>
      )}
      {race.phase === 'decided' && (
        <button className="btn small" onClick={() => void discardRace(race.id)}>
          Discard all
        </button>
      )}
    </div>
  );
}
