// The list that opens above the message box when a message starts with "/".
import {
  ArrowCounterClockwise,
  ArrowsInLineVertical,
  ArrowUUpLeft,
  BookOpen,
  Brain,
  ChatsCircle,
  Coins,
  Cpu,
  Eye,
  FileText,
  FlagCheckered,
  Hand,
  NotePencil,
  Palette,
  PlugsConnected,
  Question,
  Sparkle,
  TerminalWindow,
  type Icon,
} from '@phosphor-icons/react';
import { useEffect, useRef } from 'react';
import type { SlashCommand } from '../slashCommands';

const ICONS: Record<string, Icon> = {
  help: Question,
  new: NotePencil,
  resume: ChatsCircle,
  compact: ArrowsInLineVertical,
  model: Cpu,
  mode: Hand,
  undo: ArrowCounterClockwise,
  rewind: ArrowUUpLeft,
  review: Eye,
  deep: Brain,
  race: FlagCheckered,
  init: FileText,
  usage: Coins,
  theme: Palette,
  skills: BookOpen,
  mcp: PlugsConnected,
  commands: TerminalWindow,
};

function iconFor(command: SlashCommand): Icon {
  if (command.kind === 'skill') return BookOpen;
  if (command.kind === 'custom') return Sparkle;
  return ICONS[command.name] ?? Sparkle;
}

export function CommandMenu({ commands, index, onPick, onHover }: { commands: SlashCommand[]; index: number; onPick: (c: SlashCommand) => void; onHover: (i: number) => void }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);
  if (!commands.length) {
    return (
      <div className="command-menu" role="listbox">
        <div className="command-empty">No command matches. Esc to close, or start with a space to send it as a message.</div>
      </div>
    );
  }
  return (
    <div className="command-menu" role="listbox" aria-label="Commands" ref={list}>
      {commands.map((command, i) => {
        const CommandIcon = iconFor(command);
        return (
          <button
            key={`${command.kind}:${command.name}`}
            type="button"
            role="option"
            aria-selected={i === index}
            data-index={i}
            className={`command-item${i === index ? ' active' : ''}`}
            // Keep the focus in the message box.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(command)}
            onMouseEnter={() => onHover(i)}
          >
            <CommandIcon size={14} className="command-icon" />
            <span className="command-name">
              /{command.name}
              {command.args && <span className="command-args"> {command.args}</span>}
            </span>
            <span className="command-desc">{command.description}</span>
            {command.kind !== 'built-in' && <span className="command-kind">{command.kind === 'skill' ? 'skill' : 'yours'}</span>}
          </button>
        );
      })}
      <div className="command-hint">↑↓ to choose · Tab or Enter to pick · Esc to close</div>
    </div>
  );
}
