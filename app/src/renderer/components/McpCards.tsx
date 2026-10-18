// Integration (MCP) prompts in the chat: a tool that wants to run, a page to open, or a form to fill in.
import { ArrowSquareOut, CheckCircle, PlugsConnected, XCircle } from '@phosphor-icons/react';
import { useState } from 'react';
import { AGENT_NAME } from '../../shared/brand';
import type { ApprovalRequest } from '../../shared/ipc';
import { api } from '../api';
import { useApp } from '../store';

export function McpApproval({ request }: { request: ApprovalRequest }) {
  const answer = useApp((s) => s.answer);
  const [values, setValues] = useState<Record<string, string | boolean>>({});

  if (request.type === 'mcpTool') {
    return (
      <div className="card approval">
        <div className="card-title">
          <PlugsConnected size={15} />
          {AGENT_NAME} wants to use <span className="mono">{request.server} · {request.tool}</span>
        </div>
        {request.description && <p className="muted small">{request.description}</p>}
        {!!request.args?.length && (
          <table className="tool-args">
            <tbody>
              {request.args.map((arg) => (
                <tr key={arg.name}>
                  <td className="muted">{arg.name}</td>
                  <td className="mono">{arg.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="actions">
          <button className="btn primary" onClick={() => void answer(request.requestId, 'accept')}>
            <CheckCircle />
            Allow
          </button>
          <button className="btn" onClick={() => void answer(request.requestId, 'acceptForSession')} title="Never ask again for this tool (saved in mcp.json)">
            Always for this tool
          </button>
          <button className="btn" onClick={() => void answer(request.requestId, 'decline')}>
            <XCircle />
            Deny
          </button>
        </div>
      </div>
    );
  }

  if (request.type === 'mcpUrl') {
    return (
      <div className="card approval">
        <div className="card-title">
          <PlugsConnected size={15} />
          {request.server} asks you to open a page
        </div>
        {request.message && <p>{request.message}</p>}
        {request.url && <p className="mono small muted">{request.url}</p>}
        <div className="actions">
          <button className="btn" onClick={() => request.url && void api.app.openExternal(request.url)} disabled={!request.url?.startsWith('https://')}>
            <ArrowSquareOut />
            Open
          </button>
          <button className="btn primary" onClick={() => void answer(request.requestId, 'accept')}>
            Done
          </button>
          <button className="btn" onClick={() => void answer(request.requestId, 'cancel')}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // A form: one input per field, typed by the field's schema.
  const fields = Object.entries(request.schema?.properties ?? {});
  const submit = () => {
    const content: Record<string, unknown> = {};
    for (const [name, field] of fields) {
      const value = values[name];
      if (value === undefined || value === '') continue;
      content[name] = field.type === 'number' || field.type === 'integer' ? Number(value) : value;
    }
    void answer(request.requestId, 'accept', content);
  };
  return (
    <div className="card approval">
      <div className="card-title">
        <PlugsConnected size={15} />
        {request.server} needs something from you
      </div>
      {request.message && <p>{request.message}</p>}
      {fields.map(([name, field]) => (
        <label key={name} className="field">
          <span>
            {field.title ?? name}
            {request.schema?.required?.includes(name) && ' *'}
          </span>
          {field.type === 'boolean' ? (
            <input type="checkbox" checked={values[name] === true} onChange={(e) => setValues({ ...values, [name]: e.target.checked })} />
          ) : field.enum ? (
            <select value={String(values[name] ?? '')} onChange={(e) => setValues({ ...values, [name]: e.target.value })}>
              <option value="" />
              {field.enum.map((option) => (
                <option key={option}>{option}</option>
              ))}
            </select>
          ) : (
            <input value={String(values[name] ?? '')} onChange={(e) => setValues({ ...values, [name]: e.target.value })} type={field.type === 'number' || field.type === 'integer' ? 'number' : 'text'} />
          )}
          {field.description && <span className="muted small">{field.description}</span>}
        </label>
      ))}
      <div className="actions">
        <button className="btn primary" onClick={submit}>
          Send
        </button>
        <button className="btn" onClick={() => void answer(request.requestId, 'decline')}>
          Decline
        </button>
      </div>
    </div>
  );
}
