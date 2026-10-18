import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findImportableServers, parseMcpJson, readMcpConfig, toEngineServers, validateServer, writeMcpConfig } from './mcp';

describe('mcp config', () => {
  it('reads the common formats: Claude/Cursor mcpServers, VS Code servers, and a bare map', () => {
    const claude = parseMcpJson('{"mcpServers":{"files":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","C:/x"],"env":{"A":"1","B":2}}}}');
    expect(claude).toEqual([{ name: 'files', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:/x'], env: { A: '1' } }]);
    expect(parseMcpJson('{"servers":{"gh":{"type":"http","url":"https://api.example.com/mcp","headers":{"Authorization":"Bearer t"}}}}')).toEqual([
      { name: 'gh', url: 'https://api.example.com/mcp', headers: { Authorization: 'Bearer t' } },
    ]);
    expect(parseMcpJson('{"x":{"command":"node","disabled":true,"alwaysAllow":["read"]}}')).toEqual([{ name: 'x', command: 'node', disabled: true, alwaysAllow: ['read'] }]);
    expect(parseMcpJson('{"mcpServers":{"bad name!":{"command":"x"},"empty":{}}}')).toEqual([]);
  });

  it('validates names, commands and URLs', () => {
    expect(validateServer({ name: 'ok', command: 'npx' })).toBeUndefined();
    expect(validateServer({ name: 'ok', url: 'https://x.dev/mcp' })).toBeUndefined();
    expect(validateServer({ name: 'ok', url: 'http://localhost:3000/mcp' })).toBeUndefined();
    expect(validateServer({ name: 'ok', url: 'http://example.com/mcp' })).toMatch(/https/);
    expect(validateServer({ name: 'ok', command: ' ' })).toMatch(/command/);
    expect(validateServer({ name: 'no spaces', command: 'x' })).toMatch(/name/);
  });

  it('writes the file it reads, and builds the engine table', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'mooch-mcp-')), 'mcp.json');
    writeMcpConfig(file, [
      { name: 'files', command: 'npx', args: ['-y', 'pkg'], alwaysAllow: ['read_file'] },
      { name: 'off', command: 'x', disabled: true },
      { name: 'remote', url: 'https://x.dev/mcp', headers: { Authorization: 'Bearer t' } },
    ]);
    const { servers } = readMcpConfig(file);
    expect(servers.map((s) => s.name)).toEqual(['files', 'off', 'remote']);
    const engine = toEngineServers(servers, (c) => `C:/bin/${c}.cmd`);
    expect(Object.keys(engine)).toEqual(['files', 'remote']); // disabled servers are left out
    expect(engine.files).toMatchObject({ command: 'C:/bin/npx.cmd', args: ['-y', 'pkg'], default_tools_approval_mode: 'writes', tools: { read_file: { approval_mode: 'approve' } } });
    expect(engine.remote).toMatchObject({ url: 'https://x.dev/mcp', http_headers: { Authorization: 'Bearer t' } });
  });

  it('reports a broken mcp.json instead of throwing', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'mooch-mcp-')), 'mcp.json');
    writeFileSync(file, '{ not json');
    expect(readMcpConfig(file)).toMatchObject({ servers: [], error: expect.stringMatching(/could not be read/) });
  });

  it('finds servers in other apps to import', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mooch-mcp-'));
    mkdirSync(path.join(home, '.cursor'));
    writeFileSync(path.join(home, '.cursor', 'mcp.json'), '{"mcpServers":{"fetch":{"command":"uvx","args":["mcp-server-fetch"]}}}');
    expect(findImportableServers([{ app: 'Cursor', file: path.join(home, '.cursor', 'mcp.json') }, { app: 'None', file: path.join(home, 'missing.json') }])).toEqual([
      { name: 'fetch', command: 'uvx', args: ['mcp-server-fetch'], app: 'Cursor' },
    ]);
  });
});
