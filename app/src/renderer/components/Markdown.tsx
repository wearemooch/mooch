// Markdown for model output (agent replies, plans, reviews). No raw HTML, and links are shown, not
// followed: the app window never navigates.
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const components: Components = {
  a: ({ children, href }) => (
    <span className="md-link" title={href}>
      {children}
    </span>
  ),
  pre: ({ children }) => <pre className="md-pre">{children}</pre>,
  img: ({ alt }) => <span className="muted">[image{alt ? `: ${alt}` : ''}]</span>,
};

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
