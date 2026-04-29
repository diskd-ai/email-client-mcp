#!/usr/bin/env node
/**
 * Stdio MCP smoke test:
 *   1. Spawn dist/server.js stdio with the fixture config.
 *   2. Send `initialize` -> expect a server capabilities reply.
 *   3. Send `notifications/initialized`.
 *   4. Send `tools/list` -> expect 9 tool names matching the spec.
 *   5. Call `list_accounts` -> expect one account named "smoke-account".
 *   6. Kill the server and exit 0 on success / non-zero on any failure.
 *
 * Stdout is JSON-RPC; stderr carries the server logs.
 */

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const serverPath = resolve(root, 'dist/server.js');
const configPath = resolve(root, 'tests/fixtures/example.config.toml');

const expectedTools = [
  'list_accounts',
  'list_mailbox_folder',
  'find_mailbox_folder',
  'list_emails',
  'get_email',
  'get_emails',
  'move_email',
  'bulk_action',
  'get_watcher_status',
];

const child = spawn('node', [serverPath, 'stdio'], {
  env: {
    ...process.env,
    EMAIL_CLIENT_MCP_CONFIG: configPath,
    APIS_BASE_URL: 'http://localhost:0',
    APIS_API_KEY: 'smoke-key',
  },
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = '';
const pending = new Map();

child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let idx = buf.indexOf('\n');
  while (idx !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    idx = buf.indexOf('\n');
    if (line.length === 0) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve: r } = pending.get(msg.id);
      pending.delete(msg.id);
      r(msg);
    }
  }
});

let nextId = 1;
const send = (method, params = undefined) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    const payload = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }
    }, 10_000);
  });

const sendNotification = (method, params = undefined) => {
  const payload = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) };
  child.stdin.write(`${JSON.stringify(payload)}\n`);
};

const fail = (msg) => {
  console.error(`[smoke] FAIL: ${msg}`);
  child.kill('SIGINT');
  process.exit(1);
};

const main = async () => {
  const init = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0' },
  });
  if (init.error) fail(`initialize error: ${JSON.stringify(init.error)}`);
  if (!init.result?.serverInfo?.name) fail('no serverInfo.name in initialize result');
  console.log(`[smoke] initialize ok: ${init.result.serverInfo.name}`);

  sendNotification('notifications/initialized');

  const listed = await send('tools/list');
  if (listed.error) fail(`tools/list error: ${JSON.stringify(listed.error)}`);
  const names = (listed.result?.tools ?? []).map((t) => t.name).sort();
  const want = [...expectedTools].sort();
  for (const w of want) {
    if (!names.includes(w)) fail(`tools/list missing ${w}`);
  }
  console.log(`[smoke] tools/list ok: ${names.length} tools`);

  const accts = await send('tools/call', { name: 'list_accounts', arguments: {} });
  if (accts.error) fail(`list_accounts error: ${JSON.stringify(accts.error)}`);
  const text = accts.result?.content?.[0]?.text;
  if (!text) fail('list_accounts: empty content');
  const data = JSON.parse(text);
  if (!Array.isArray(data.accounts)) fail('list_accounts: missing accounts[]');
  if (data.accounts.length !== 1 || data.accounts[0].name !== 'smoke-account') {
    fail(`list_accounts: unexpected ${JSON.stringify(data)}`);
  }
  console.log('[smoke] list_accounts ok');

  const status = await send('tools/call', { name: 'get_watcher_status', arguments: {} });
  if (status.error) fail(`get_watcher_status error: ${JSON.stringify(status.error)}`);
  const sObj = JSON.parse(status.result.content[0].text);
  if (typeof sObj.running !== 'boolean') fail('watcher status missing running flag');
  if (sObj.running !== false) fail('watcher should not be running (config disabled it)');
  console.log('[smoke] get_watcher_status ok');

  child.kill('SIGINT');
  setTimeout(() => process.exit(0), 200);
};

main().catch((e) => fail(e.message));
