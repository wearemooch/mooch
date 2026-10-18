// A tiny MCP server for tests (stdio, newline-delimited JSON-RPC, no dependencies).
// Tools: get_codeword (read-only) and save_note (writes to the file named by FIXTURE_LOG).
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const TOOLS = [
  {
    name: 'get_codeword',
    description: "Returns the project's secret codeword.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'save_note',
    description: 'Saves a short note on the notes server.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'The note' } }, required: ['text'] },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = request;
  if (id === undefined) return; // notifications
  switch (method) {
    case 'initialize':
      return send({ id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } } });
    case 'ping':
      return send({ id, result: {} });
    case 'tools/list':
      return send({ id, result: { tools: TOOLS } });
    case 'tools/call': {
      const name = params?.name;
      if (name === 'get_codeword') return send({ id, result: { content: [{ type: 'text', text: 'OSPREY-11' }] } });
      if (name === 'save_note') {
        const text = String(params?.arguments?.text ?? '');
        if (process.env.FIXTURE_LOG) appendFileSync(process.env.FIXTURE_LOG, `${text}\n`);
        return send({ id, result: { content: [{ type: 'text', text: `Saved: ${text}` }] } });
      }
      return send({ id, result: { content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true } });
    }
    default:
      return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});
