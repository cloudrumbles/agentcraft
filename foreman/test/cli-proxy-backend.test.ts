// Actual Foreman scheduler/worktrees/policy/MCP/session persistence, with only SDK query scripted.
import path from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeBackend } from '../src/agents/claude/index.js';
import { OPUS_MODEL, SOL_MODEL } from '../src/agents/cli-proxy.js';
import { demoRepo, makeForeman, rmrf, tempDir, until, type Harness } from './helpers.js';

type ToolServer = { instance: { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }> }> } };
const tools = (options: Options) => (options.mcpServers!.agentcraft as unknown as ToolServer).instance._registeredTools;
const callTool = async (options: Options, name: string, args: object) => (await tools(options)[name]!.handler(args, {})).content.map((content) => content.text).join('\n');
const sid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const message = (value: object) => ({ parent_tool_use_id: null, uuid: sid(100), ...value }) as SDKMessage;
const init = (session: string, model: string) => message({ type: 'system', subtype: 'init', session_id: session, model });
const success = (session: string) => message({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: session, num_turns: 1, total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1, usage: {}, modelUsage: {}, permission_denials: [] });
const KEY = 'local-proxy-backend-fixture-credential';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function harness(): Promise<Harness> {
  vi.stubEnv('CLIPROXY_API_KEY', KEY);
  const home = tempDir('ac-proxy-backend-');
  const repo = await demoRepo();
  cleanups.push(() => { rmrf(home); rmrf(path.dirname(repo)); });
  const h = makeForeman(home, ['--backend', 'cli-proxy', '--workers', 'wren,kit', '--repo', repo]);
  cleanups.push(() => h.fm.close());
  return h;
}

describe('CLIProxyAPI Foreman integration (scripted query, real orchestration)', () => {
  it('routes Wren and Kit correctly with MCP, permissions and git safety, and rejects changed-model resume', async () => {
    const h = await harness();
    const calls: Array<{ agent: string; prompt: string; options: Options }> = [];
    const permissions: Record<string, string[]> = {};
    const queryFn = ({ prompt, options }: { prompt: string; options: Options }) => {
      const lead = 'create_task' in tools(options);
      const agent = lead ? 'marlow' : options.cwd!.includes('wren-') ? 'wren' : 'kit';
      calls.push({ agent, prompt: String(prompt), options });
      const session = sid(agent === 'marlow' ? 1 : agent === 'wren' ? 2 : 3);
      async function* run(): AsyncGenerator<SDKMessage> {
        yield init(session, options.model!);
        if (lead && String(prompt).startsWith('New goal')) {
          await callTool(options, 'create_task', { title: 'Wren protocol test', description: 'Test routing and stop blocked.', assignee: 'wren' });
          await callTool(options, 'create_task', { title: 'Kit protocol test', description: 'Test routing and stop blocked.', assignee: 'kit' });
        } else if (!lead) {
          const taskId = /Your task: (t\d+)/.exec(String(prompt))?.[1] ?? (agent === 'wren' ? 't1' : 't2');
          const context = { signal: new AbortController().signal, toolUseID: 'test-tool', requestId: 'test-request' } as never;
          const allowed = await options.canUseTool!('Bash', { command: 'git status --short' }, context);
          const denied = await options.canUseTool!('Bash', { command: 'git push origin main' }, context);
          permissions[agent] = [allowed?.behavior ?? 'missing', denied?.behavior ?? 'missing'];
          await callTool(options, 'report_status', { activity: `${agent} MCP verified`, note: 'In-process MCP is working.' });
          await callTool(options, 'update_task', { task_id: taskId, status: 'blocked', blocked_reason: 'Routing fixture completed; no source changes needed.' });
        }
        yield success(session);
      }
      return Object.assign(run(), { close() {}, accountInfo: async () => ({}) });
    };
    const b = new ClaudeBackend(h.fm, h.cfg.claude, { cliProxy: h.cfg.cliProxy, queryFn: queryFn as never, skipAuthCheck: true });
    // A blocked task can become visible before afterTurn/session cleanup finishes. Wait for
    // actual turn completion before editing its model or taking a query-count baseline.
    const lifecycle = b as unknown as {
      quiesce(agent: string): Promise<void>;
      running: Map<string, unknown>;
      queues: Map<string, unknown[]>;
    };
    const settle = async () => {
      await Promise.all(['marlow', 'wren', 'kit'].map((agent) => lifecycle.quiesce(agent)));
      await until(() => lifecycle.running.size === 0 && [...lifecycle.queues.values()].every((queue) => queue.length === 0));
    };
    await h.fm.start(b);
    const goal = await h.fm.submitGoal('Verify Wren and Kit proxy model routing');
    await until(() => h.fm.tasks.list().length === 2 && h.fm.tasks.list().every((task) => task.status === 'blocked') && !!h.fm.store.data.sessions['kit:t2']);
    await settle();

    expect([...new Set(calls.map(({ agent }) => agent))].sort()).toEqual(['kit', 'marlow', 'wren']);
    for (const { agent, options } of calls) {
      const expected = agent === 'kit' ? SOL_MODEL : OPUS_MODEL;
      expect(options.model).toBe(expected);
      expect(options.fallbackModel).toBeUndefined();
      expect(options.env).toMatchObject({ ANTHROPIC_MODEL: expected, ANTHROPIC_DEFAULT_OPUS_MODEL: expected, ANTHROPIC_DEFAULT_SONNET_MODEL: expected, ANTHROPIC_DEFAULT_HAIKU_MODEL: expected, ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_BASE_URL: h.cfg.cliProxy.baseUrl });
      expect(options.settingSources).toEqual([]);
      expect(options.permissionMode).toBe('default');
      expect(options.canUseTool).toBeTypeOf('function');
      expect(options.allowedTools).toBeUndefined();
      expect(options.disallowedTools).toContain('Bash(git push:*)');
      expect(options.spawnClaudeCodeProcess).toBeTypeOf('function');
      expect(tools(options).report_status).toBeDefined();
      expect(options.env!.GIT_AUTHOR_EMAIL).toBe(`${agent}@agentcraft.local`);
      const gitConfig = Object.fromEntries(Array.from({ length: Number(options.env!.GIT_CONFIG_COUNT) }, (_, index) => [options.env![`GIT_CONFIG_KEY_${index}`], options.env![`GIT_CONFIG_VALUE_${index}`]]));
      expect(gitConfig).toMatchObject({ 'commit.gpgsign': 'false', 'protocol.allow': 'never' });
      if (agent !== 'marlow') expect(options.cwd).toContain(path.join('worktrees', 'demo-app', `${agent}-`));
    }
    expect(permissions).toEqual({ wren: ['allow', 'deny'], kit: ['allow', 'deny'] });
    expect(h.fm.store.data.sessions[`marlow:${goal.id}`]?.model).toBe(OPUS_MODEL);
    expect(h.fm.store.data.sessions['wren:t1']?.model).toBe(OPUS_MODEL);
    expect(h.fm.store.data.sessions['kit:t2']?.model).toBe(SOL_MODEL);
    expect(h.fm.store.logTail('wren').some((entry) => entry.text === 'In-process MCP is working.')).toBe(true);

    // Reusing a task after a model change must not silently submit another provider's transcript.
    const wrenCallsBeforeChange = calls.filter(({ agent }) => agent === 'wren').length;
    h.cfg.claude.agentModels.wren = SOL_MODEL;
    h.fm.taskAction('t1', 'retry');
    await until(() => h.fm.tasks.get('t1')?.blockedReason?.includes('Session model changed') === true);
    await settle();
    expect(calls.filter(({ agent }) => agent === 'wren')).toHaveLength(wrenCallsBeforeChange);
    expect(h.fm.store.data.sessions['wren:t1']?.model).toBe(OPUS_MODEL);
    expect(h.fm.tasks.get('t1')?.blockedReason).toContain('new profile');

    // Restoring the original model permits normal session resume; no fallback was persisted.
    h.cfg.claude.agentModels.wren = OPUS_MODEL;
    h.fm.taskAction('t1', 'retry');
    await until(() => calls.filter(({ agent }) => agent === 'wren').length > wrenCallsBeforeChange && h.fm.tasks.get('t1')?.status === 'blocked');
    await settle();
    for (const call of calls.filter(({ agent }) => agent === 'wren').slice(wrenCallsBeforeChange)) {
      expect(call.options, call.prompt).toMatchObject({ model: OPUS_MODEL, resume: sid(2) });
      expect(call.options.fallbackModel).toBeUndefined();
    }
  });

  it('redacts echoed credentials in mapped SDK messages, caught errors, persisted state and UI logs', async () => {
    const h = await harness();
    const errors = vi.spyOn(h.fm.log, 'error');
    const queryFn = ({ options }: { options: Options }) => {
      async function* run(): AsyncGenerator<SDKMessage> {
        yield init(sid(9), options.model!);
        yield message({ type: 'assistant', session_id: sid(9), message: { role: 'assistant', content: [{ type: 'text', text: `Gateway rejected credential ${KEY}` }] } });
        yield message({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [`API error: ${KEY}`], session_id: sid(9), total_cost_usd: 0, num_turns: 1 });
        throw new Error(`401 gateway authentication failed for ${KEY}`);
      }
      return Object.assign(run(), { close() {}, accountInfo: async () => ({}) });
    };
    await h.fm.start(new ClaudeBackend(h.fm, h.cfg.claude, { cliProxy: h.cfg.cliProxy, queryFn: queryFn as never, skipAuthCheck: true }));
    await h.fm.submitGoal('Verify proxy error redaction');
    await until(() => h.fm.status.auth === 'failed' && h.fm.agent('marlow')?.state === 'error');
    const visible = JSON.stringify({ state: h.fm.store.data, status: h.fm.status, events: h.events, agentLogs: h.fm.store.logTail('marlow'), errors: errors.mock.calls });
    expect(visible).not.toContain(KEY);
    expect(visible).toContain('[REDACTED]');
    expect(h.fm.status.message).toContain('CLIProxyAPI authentication failed');
  });
});
