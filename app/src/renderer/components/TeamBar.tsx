// Toggles for the team features plus a panel showing (and overriding) which model plays which role.
import { ArrowsSplit, Brain, Eye, UsersThree, X, type Icon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import type { FreeCodeSettings, TeamSettings } from '../../shared/ipc';
import { AGENT_NAME } from '../../shared/brand';
import { groupByProvider, modelLabel, shortModelName } from '../../shared/modelNames';
import { useApp } from '../store';

const TOGGLES: { key: 'deep' | 'review' | 'hedge'; label: string; icon: Icon; hint: string }[] = [
  { key: 'deep', label: 'Deep thinking', icon: Brain, hint: 'Before each message, 3 models plan and a judge merges the plans (+4 calls)' },
  { key: 'review', label: 'Review', icon: Eye, hint: `A second model reviews every change and ${AGENT_NAME} fixes what it flags (+1 call)` },
  {
    key: 'hedge',
    label: 'Backup',
    icon: ArrowsSplit,
    hint: 'If the model is slow, also ask a backup model and keep whichever answers first (Settings > Chat sets how soon). If it hits its limit, the chat switches to the backup. Off: only the model you picked answers.',
  },
];

function RoleSelect({ label, value, auto, onChange }: { label: string; value?: string; auto?: string; onChange: (v?: string) => void }) {
  const models = useApp((s) => s.models);
  return (
    <label className="role">
      <span>{label}</span>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">Auto: {auto ? modelLabel(auto) : 'none'}</option>
        {groupByProvider(models).map((group) => (
          <optgroup key={group.provider} label={group.provider}>
            {group.models.map((m) => (
              <option key={m.slug} value={m.slug}>
                {shortModelName(m.slug)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

function TeamPanel({ settings, onClose }: { settings: FreeCodeSettings; onClose: () => void }) {
  const team = useApp((s) => s.team);
  const updateSettings = useApp((s) => s.updateSettings);
  const setTeam = (patch: Partial<TeamSettings>) => void updateSettings({ team: { ...settings.team, ...patch } });
  const [testCommand, setTestCommand] = useState(settings.raceTestCommand ?? '');
  if (!team) return null;
  return (
    <div className="team-panel" role="dialog" aria-label="Team">
      <div className="card-title">
        Team <span className="spacer" />
        <button className="tab-close" onClick={onClose} aria-label="Close">
          <X size={14} />
        </button>
      </div>
      {team.singleProvider && (
        <p className="notice-inline">Only one provider is set up, so the team uses different models from it. Add a free Groq, Gemini or OpenRouter key in Settings for real diversity.</p>
      )}
      <RoleSelect label="Reviewer" value={settings.team.reviewer} auto={team.reviewer} onChange={(reviewer) => setTeam({ reviewer })} />
      <RoleSelect label="Backup (hedge)" value={settings.team.backup} auto={team.backup} onChange={(backup) => setTeam({ backup })} />
      <RoleSelect label="Judge" value={settings.team.judge} auto={team.judge} onChange={(judge) => setTeam({ judge })} />
      {[0, 1, 2].map((i) => (
        <RoleSelect
          key={`p${i}`}
          label={`Planner ${i + 1}`}
          value={settings.team.planners?.[i]}
          auto={team.planners[i]}
          onChange={(slug) => {
            const planners = [...(settings.team.planners ?? team.planners)];
            planners[i] = slug ?? team.planners[i] ?? '';
            setTeam({ planners: planners.filter(Boolean) });
          }}
        />
      ))}
      {[0, 1, 2].map((i) => (
        <RoleSelect
          key={`c${i}`}
          label={`Racer ${i + 1}`}
          value={settings.team.contestants?.[i]}
          auto={team.contestants[i]}
          onChange={(slug) => {
            const contestants = [...(settings.team.contestants ?? team.contestants)];
            contestants[i] = slug ?? team.contestants[i] ?? '';
            setTeam({ contestants: contestants.filter(Boolean) });
          }}
        />
      ))}
      <label className="role">
        <span>File edits</span>
        <select
          value={settings.editTool}
          onChange={(e) => void updateSettings({ editTool: e.target.value as FreeCodeSettings['editTool'] })}
          title="Applies to the next chat"
        >
          <option value="auto">Auto: edit tools for non-OpenAI models</option>
          <option value="edit_file">Edit tools (edit_file / write_file)</option>
          <option value="apply_patch">Patch format (apply_patch)</option>
        </select>
      </label>
      <label className="role">
        <span>Race test command</span>
        <input
          value={testCommand}
          placeholder="Auto-detect (e.g. npm test)"
          onChange={(e) => setTestCommand(e.target.value)}
          onBlur={() => void updateSettings({ raceTestCommand: testCommand.trim() || undefined })}
        />
      </label>
      <button className="btn small" onClick={() => void updateSettings({ team: {} })}>
        Reset to auto
      </button>
    </div>
  );
}

export function TeamBar() {
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);
  const loadSettings = useApp((s) => s.loadSettings);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);
  if (!settings) return null;
  return (
    <div className="team-bar">
      {TOGGLES.map((t) => (
        <button
          key={t.key}
          className={`chip${settings[t.key] ? ' on' : ''}`}
          aria-pressed={settings[t.key]}
          title={t.hint}
          onClick={() => void updateSettings({ [t.key]: !settings[t.key] })}
        >
          {/* Fill only for "on" states. */}
          <t.icon size={13} weight={settings[t.key] ? 'fill' : 'regular'} />
          {t.label}
        </button>
      ))}
      <span className="spacer" />
      <button className="chip" onClick={() => setOpen(!open)} aria-expanded={open}>
        <UsersThree size={13} weight={open ? 'fill' : 'regular'} />
        Team…
      </button>
      {open && <TeamPanel settings={settings} onClose={() => setOpen(false)} />}
    </div>
  );
}
