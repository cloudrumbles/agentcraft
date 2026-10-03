// Contract tests against the REAL installed Agent SDK/CLI. The only model endpoint is this
// loopback Messages fixture: no Claude account, provider credentials, or paid requests needed.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createSdkMcpServer, query, tool, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SOL_MODEL, withProxyEnv } from '../src/agents/cli-proxy.js';

type Block = { type: string; [key: string]: unknown };
type MessageRequest = {
  model: string;
  stream?: boolean;
  messages: Array<{ role: string; content: string | Block[] }>;
  tools?: Array<{ name: string }>;
};
type RecordedRequest = { body: MessageRequest; authorization: string | undefined };

const TOOL_NAME = 'mcp__agentcraft__echo';
const TOOL_VALUE = 'local-proxy-roundtrip';
const TOOL_RESULT = `echo:${TOOL_VALUE}`;
const FINAL_TEXT = 'Local proxy tool roundtrip complete.';
const RESUME_TEXT = 'Resumed the persisted local session.';
const FAKE_TOKEN = 'agentcraft-local-fixture-not-a-real-key';

function sendStream(response: http.ServerResponse, model: string, block: Block) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const event = (value: Record<string, unknown>) => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  const isTool = block.type === 'tool_use';
  event({ type: 'message_start', message: {
    id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model, content: [],
    stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  } });
  event({ type: 'content_block_start', index: 0, content_block: isTool ? { ...block, input: {} } : { type: 'text', text: '' } });
  if (isTool) {
    const json = JSON.stringify(block.input);
    // Split the input so this verifies actual incremental JSON assembly in the SDK.
    for (const partial_json of [json.slice(0, 9), json.slice(9)]) {
      event({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } });
    }
  } else {
    for (const text of [String(block.text).slice(0, 8), String(block.text).slice(8)]) {
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    }
  }
  event({ type: 'content_block_stop', index: 0 });
  event({ type: 'message_delta', delta: { stop_reason: isTool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
  event({ type: 'message_stop' });
  response.end();
}

async function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcraft-proxy-sdk-'));
  const cwd = path.join(home, 'repo');
  fs.mkdirSync(cwd);
  const requests: RecordedRequest[] = [];
  const unexpected: string[] = [];
  let onMessage: (body: MessageRequest, response: http.ServerResponse) => void = (body, response) => {
    if (JSON.stringify(body.messages).includes('Resume this local session')) {
      sendStream(response, body.model, { type: 'text', text: RESUME_TEXT });
    } else if (JSON.stringify(body.messages).includes(TOOL_RESULT)) {
      sendStream(response, body.model, { type: 'text', text: FINAL_TEXT });
    } else {
      sendStream(response, body.model, { type: 'tool_use', id: 'toolu_local_echo', name: TOOL_NAME, input: { text: TOOL_VALUE } });
    }
  };
  const server = http.createServer(async (request, response) => {
    try {
      // HTTP(S)_PROXY also points here. Never forward CONNECT or absolute external URLs.
      const url = request.url ?? '';
      if (request.method === 'GET' && /^\/v1\/models(?:\?|$)/.test(url)) {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          data: ['claude-opus-5-5', 'gpt-6.1-sol'].map((id) => ({ id, type: 'model', display_name: id, created_at: '2026-01-01T00:00:00Z' })),
          has_more: false,
        }));
        return;
      }
      if (request.method !== 'POST' || !/^\/v1\/messages(?:\?|$)/.test(url)) {
        unexpected.push(`${request.method} ${url}`);
        response.writeHead(502).end('Only local fixture Messages requests are allowed');
        return;
      }
      let raw = '';
      for await (const chunk of request) raw += String(chunk);
      const body = JSON.parse(raw) as MessageRequest;
      requests.push({ body, authorization: request.headers.authorization });
      onMessage(body, response);
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
  server.on('connect', (request, socket) => {
    unexpected.push(`CONNECT ${request.url}`);
    socket.end('HTTP/1.1 502 Local fixture only\r\n\r\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const stderr: string[] = [];
  const options: Options = {
    cwd,
    // Options.env replaces the child environment. Deliberately do not spread process.env:
    // inherited OAuth/API keys, provider selectors, proxy settings, and user hooks stay out.
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      TMPDIR: home,
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      AGENTCRAFT_FIXTURE_KEY: FAKE_TOKEN,
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_AUTOUPDATER: '1',
      HTTP_PROXY: baseUrl,
      HTTPS_PROXY: baseUrl,
      ALL_PROXY: baseUrl,
      NO_PROXY: '127.0.0.1,localhost',
    },
    settingSources: [],
    tools: [],
    allowedTools: [TOOL_NAME],
    systemPrompt: 'You are a local protocol test. Use the supplied echo tool, then answer.',
    includePartialMessages: true,
    maxTurns: 4,
    thinking: { type: 'disabled' },
    stderr: (line) => stderr.push(line),
  };
  return {
    options, requests, unexpected, stderr,
    forModel(model: string): Options {
      return { ...options, model, env: withProxyEnv(options.env ?? {}, { baseUrl, apiKeyEnv: 'AGENTCRAFT_FIXTURE_KEY' }, model) };
    },
    setResponse(handler: typeof onMessage) { onMessage = handler; },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

async function* input(content: string): AsyncGenerator<SDKUserMessage> {
  yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content } };
}

async function collect(prompt: string, options: Options): Promise<SDKMessage[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  const session = query({ prompt: input(prompt), options: { ...options, abortController: controller } });
  try {
    const messages: SDKMessage[] = [];
    for await (const message of session) messages.push(message);
    return messages;
  } finally {
    clearTimeout(timeout);
    session.close();
  }
}

describe('CLIProxyAPI Messages compatibility (real installed Claude Agent SDK, localhost only)', () => {
  it.each(['claude-opus-5-5', 'gpt-6.1-sol'])('passes through %s, streams an MCP tool roundtrip, and resumes its session', async (model) => {
    const f = await fixture();
    const calls: string[] = [];
    const mcpServer = () => createSdkMcpServer({
      name: 'agentcraft', version: '1.0.0',
      tools: [tool('echo', 'Echo a test value', { text: z.string() }, async ({ text }) => {
        calls.push(text);
        return { content: [{ type: 'text' as const, text: `echo:${text}` }] };
      })],
    });
    try {
      const messages = await collect('Run the local echo tool.', { ...f.forModel(model), mcpServers: { agentcraft: mcpServer() } });
      const result = messages.find((message) => message.type === 'result');
      expect(result, f.stderr.join('')).toMatchObject({ type: 'result', subtype: 'success', is_error: false, result: FINAL_TEXT });
      expect(calls).toEqual([TOOL_VALUE]);
      expect(f.requests).toHaveLength(2);
      expect(f.requests.every(({ body, authorization }) => body.model === model && body.stream === true && authorization === `Bearer ${FAKE_TOKEN}`)).toBe(true);
      expect(f.requests[0]!.body.tools?.some(({ name }) => name === TOOL_NAME)).toBe(true);
      expect(f.requests[1]!.body.messages.some(({ role, content }) => role === 'user' && Array.isArray(content) && content.some((block) => block.type === 'tool_result' && block.tool_use_id === 'toolu_local_echo' && JSON.stringify(block.content).includes(TOOL_RESULT)))).toBe(true);
      expect(messages.some((message) => message.type === 'assistant' && message.message.content.some((block) => block.type === 'tool_use' && block.name === TOOL_NAME))).toBe(true);
      expect(messages.some((message) => message.type === 'stream_event' && message.event.type === 'content_block_delta' && message.event.delta.type === 'text_delta')).toBe(true);
      expect(result?.session_id).toMatch(/^[\da-f-]{36}$/);

      const resumed = await collect('Resume this local session and recall the earlier tool result.', { ...f.forModel(model), resume: result!.session_id, mcpServers: { agentcraft: mcpServer() } });
      expect(resumed.find((message) => message.type === 'result'), f.stderr.join('')).toMatchObject({ subtype: 'success', session_id: result!.session_id, result: RESUME_TEXT });
      expect(f.requests).toHaveLength(3);
      expect(JSON.stringify(f.requests[2]!.body.messages)).toContain(TOOL_RESULT);
      expect(f.requests[2]!.body.model).toBe(model);
      expect(calls).toEqual([TOOL_VALUE]);
      expect(f.unexpected).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('aborts an in-flight gateway stream and closes its HTTP connection', async () => {
    const f = await fixture();
    const controller = new AbortController();
    let requestStarted!: () => void;
    let connectionClosed!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    const closed = new Promise<void>((resolve) => { connectionClosed = resolve; });
    f.setResponse((_body, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      response.once('close', connectionClosed);
      requestStarted();
      // Leave the stream pending so cancellation, rather than a synthetic result, ends it.
    });
    const session = query({ prompt: input('Wait for a local streaming response.'), options: {
      ...f.forModel('gpt-6.1-sol'), abortController: controller,
    } });
    const messages: SDKMessage[] = [];
    const outcome = (async () => {
      try {
        for await (const message of session) messages.push(message);
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    const timeout = setTimeout(() => { controller.abort(); session.close(); }, 15_000);
    try {
      await Promise.race([started, outcome.then((error) => { throw error ?? new Error('SDK exited before sending the request'); })]);
      controller.abort();
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/abort/i);
      await closed;
      expect(messages.some((message) => message.type === 'result' && !message.is_error)).toBe(false);
      expect(f.requests).toHaveLength(1);
      expect(f.unexpected).toEqual([]);
    } finally {
      clearTimeout(timeout);
      session.close();
      await f.close();
    }
  });

  it('does not forward the gateway credential on a cross-origin Messages redirect', async () => {
    const source = await fixture();
    const target = await fixture();
    try {
      target.setResponse((body, response) => sendStream(response, body.model, { type: 'text', text: FINAL_TEXT }));
      const destination = target.forModel(SOL_MODEL).env!.ANTHROPIC_BASE_URL;
      source.setResponse((_body, response) => response.writeHead(307, { location: `${destination}/v1/messages` }).end());
      const messages = await collect('Local redirect safety test.', source.forModel(SOL_MODEL));
      expect(messages.find((message) => message.type === 'result')).toMatchObject({ subtype: 'success', result: FINAL_TEXT });
      expect(source.requests).toHaveLength(1);
      expect(target.requests).toHaveLength(1);
      expect(target.requests[0]!.authorization).toBeUndefined();
    } finally {
      await source.close();
      await target.close();
    }
  });
});
