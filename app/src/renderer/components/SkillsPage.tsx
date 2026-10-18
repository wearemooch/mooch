// Settings > Skills: what's installed, and installing from a folder, a .zip, GitHub, or other apps.
import { BookOpen, DownloadSimple, FileZip, FolderOpen, GithubLogo, Trash, Warning } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { AGENT_NAME } from '../../shared/brand';
import type { InstalledSkill, SkillPreparation } from '../../shared/ipc';
import { api, errorMessage } from '../api';
import { useApp } from '../store';

function InstallConfirm({ prep, onDone }: { prep: SkillPreparation; onDone: (message?: string) => void }) {
  const [chosen, setChosen] = useState<Set<string>>(new Set(prep.candidates.filter((c) => !c.exists).map((c) => c.name)));
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const toggle = (name: string) => setChosen((set) => (set.has(name) ? new Set([...set].filter((n) => n !== name)) : new Set([...set, name])));
  const anyExisting = prep.candidates.some((c) => c.exists && chosen.has(c.name));
  const install = async () => {
    setBusy(true);
    try {
      const installed = await api.skills.install(prep.token, [...chosen], replace);
      onDone(installed.length ? `Installed ${installed.join(', ')}.` : 'Nothing was installed.');
    } catch (error) {
      onDone(errorMessage(error));
    }
  };
  return (
    <div className="card skill-confirm">
      <div className="card-title">
        {prep.candidates.length === 1 ? 'Install this skill?' : `Found ${prep.candidates.length} skills. Pick the ones to install.`}
      </div>
      {prep.candidates.map((c) => (
        <label key={c.name} className="skill-candidate">
          <input type="checkbox" checked={chosen.has(c.name)} onChange={() => toggle(c.name)} />
          <span>
            <strong>{c.name}</strong>
            {c.exists && <span className="tag">installed</span>}
            {c.hasScripts && <span className="tag busy">scripts</span>}
            <span className="muted block">{c.description}</span>
            <span className="muted small block">
              {c.fileCount} file{c.fileCount === 1 ? '' : 's'}: {c.files.slice(0, 6).join(', ')}
              {c.fileCount > 6 ? ', …' : ''}
            </span>
          </span>
        </label>
      ))}
      {prep.candidates.some((c) => c.hasScripts && chosen.has(c.name)) && (
        <p className="muted small with-icon top">
          <Warning size={14} />
          Contains scripts. Installing never runs them; {AGENT_NAME} runs them only like any other command, with your approval in Ask first.
        </p>
      )}
      {anyExisting && (
        <label className="small with-icon">
          <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
          Replace the installed versions
        </label>
      )}
      <div className="actions">
        <button className="btn primary small" disabled={busy || chosen.size === 0 || (anyExisting && !replace && [...chosen].every((n) => prep.candidates.find((c) => c.name === n)?.exists))} onClick={() => void install()}>
          <DownloadSimple size={14} />
          Install
        </button>
        <button
          className="btn small"
          onClick={() => {
            void api.skills.discard(prep.token);
            onDone();
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function SkillsPage() {
  const workspace = useApp((s) => s.workspace);
  const [skills, setSkills] = useState<InstalledSkill[]>([]);
  const [prep, setPrep] = useState<SkillPreparation>();
  const [githubUrl, setGithubUrl] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);

  const reload = () => void api.skills.list().then(setSkills);
  useEffect(reload, [workspace]);

  const prepare = async (source: Parameters<typeof api.skills.prepare>[0]) => {
    setMessage(undefined);
    setBusy(true);
    try {
      const result = await api.skills.prepare(source);
      if (result) setPrep(result);
      setGithubUrl(undefined);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="muted">
        Skills teach {AGENT_NAME} how to do a kind of task: a folder with a <code>SKILL.md</code> (instructions) and sometimes scripts or reference files. It's the same format Claude
        and Codex use. {AGENT_NAME} picks a skill up when it fits, or you can run one as <code>/skill-name</code>.
      </p>
      <div className="actions wrap">
        <button className="btn small" disabled={busy} onClick={() => void prepare({ kind: 'folder' })}>
          <FolderOpen size={14} />
          From a folder…
        </button>
        <button className="btn small" disabled={busy} onClick={() => void prepare({ kind: 'zip' })}>
          <FileZip size={14} />
          From a .zip…
        </button>
        <button className="btn small" disabled={busy} onClick={() => setGithubUrl(githubUrl === undefined ? '' : undefined)}>
          <GithubLogo size={14} />
          From GitHub…
        </button>
        <button className="btn small" disabled={busy} onClick={() => void prepare({ kind: 'import' })} title="Copy skills from ~/.claude/skills, ~/.codex/skills and ~/.agents/skills">
          <DownloadSimple size={14} />
          Import from Claude / Codex
        </button>
      </div>
      {githubUrl !== undefined && (
        <form
          className="github-form"
          onSubmit={(e) => {
            e.preventDefault();
            void prepare({ kind: 'github', url: githubUrl });
          }}
        >
          <input value={githubUrl} onChange={(e) => setGithubUrl(e.target.value)} placeholder="https://github.com/anthropics/skills/tree/main/skills/pdf" autoFocus aria-label="GitHub link" />
          <button className="btn primary small" type="submit" disabled={busy || !githubUrl.trim()}>
            {busy ? 'Downloading…' : 'Look'}
          </button>
        </form>
      )}
      {message && <p className="notice-inline">{message}</p>}
      {prep && (
        <InstallConfirm
          prep={prep}
          onDone={(result) => {
            setPrep(undefined);
            if (result) setMessage(result);
            reload();
            void useApp.getState().loadCommands();
          }}
        />
      )}

      <h3>Installed</h3>
      {skills.length === 0 && <p className="muted">No skills yet.</p>}
      <div className="skill-list">
        {skills.map((skill) => (
          <div key={`${skill.scope}:${skill.name}`} className="skill-row">
            <BookOpen size={16} className="skill-icon" />
            <div className="skill-text">
              <div>
                <strong>{skill.name}</strong>
                <span className="mono muted small"> /{skill.name}</span>
                {skill.scope === 'project' && <span className="tag">this project</span>}
                {skill.hasScripts && <span className="tag busy">scripts</span>}
              </div>
              <div className="muted small">{skill.description}</div>
            </div>
            {skill.scope === 'user' && (
              <button
                className="icon-btn"
                title={`Remove ${skill.name}`}
                aria-label={`Remove ${skill.name}`}
                onClick={() =>
                  void api.skills
                    .remove(skill.name)
                    .then(reload)
                    .then(() => useApp.getState().loadCommands())
                }
              >
                <Trash size={14} />
              </button>
            )}
          </div>
        ))}
      </div>
      <button className="btn small" onClick={() => void api.skills.openFolder()}>
        <FolderOpen size={14} />
        Open skills folder
      </button>
      <p className="muted small">
        Yours are in <code>~/.mooch/skills</code>. A project can bring its own in <code>.mooch/skills</code>.
      </p>
    </>
  );
}
