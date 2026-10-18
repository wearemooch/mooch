// Expand/collapse controlled by React instead of native <details>. Native <details> toggled from React
// while the transcript streams fought the user's own clicks and left stale paint behind on some GPUs.
import { CaretRight } from '@phosphor-icons/react';
import { useState, type ReactNode } from 'react';

export function Collapsible({ title, children, open = false }: { title: ReactNode; children: ReactNode; open?: boolean }) {
  // `open` is the automatic state (e.g. expanded while a command runs) until the user toggles it.
  const [userOpen, setUserOpen] = useState<boolean>();
  const isOpen = userOpen ?? open;
  return (
    <div className={`collapsible${isOpen ? ' open' : ''}`}>
      <button type="button" className="collapsible-head" aria-expanded={isOpen} onClick={() => setUserOpen(!isOpen)}>
        <CaretRight className="caret" size={12} weight="bold" />
        {title}
      </button>
      {isOpen && <div className="collapsible-body">{children}</div>}
    </div>
  );
}
