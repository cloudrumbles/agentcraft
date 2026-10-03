import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkProxyModels, normalizeProxyUrl, OPUS_MODEL, redactProxySecrets, SOL_MODEL, withProxyEnv, type CliProxyConfig } from '../src/agents/cli-proxy.js';
import { ClaudeBackend } from '../src/agents/claude/index.js';
import { PROVIDER_SWITCHES } from '../src/agents/claude/auth.js';
import { loadConfig, type Config } from '../src/config.js';
import { LEAD_ID, WORKER_IDS } from '../src/cast.js';
import { makeForeman, rmrf, tempDir } from './helpers.js';

const KEY = 'fake-proxy-client-key-not-a-real-credential';
const KEY_ENV = 'AGENTCRAFT_TEST_PROXY_KEY';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function config(args: string[] = [], env: NodeJS.ProcessEnv = {}, file?: object): Config {
  const home = tempDir('ac-proxy-config-');
  cleanups.push(() => rmrf(home));
  if (file) fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(file));
  return loadConfig(['--home', home, '--backend', 'cli-proxy', '--no-notify', ...args], env);
}

function backend(cfg: Config, queryFn = vi.fn(() => { throw new Error('Model preflight must not start the SDK'); })) {
  const h = makeForeman(cfg.home, ['--backend', 'cli-proxy', '--no-notify']);
  cleanups.push(() => h.fm.close());
  const instance = new ClaudeBackend(h.fm, cfg.claude, { cliProxy: cfg.cliProxy, queryFn: queryFn as never });
  return { ...h, instance, queryFn };
}

function mapped(cfg: Config) {
  const b = backend(cfg).instance;
  return Object.fromEntries([LEAD_ID, ...WORKER_IDS].map((id) => [id, b.modelFor(id)]));
}

async function modelServer(handler: (request: http.IncomingMessage, response: http.ServerResponse) => void) {
  const requests: Array<{ method: string | undefined; url: string | undefined; authorization: string | undefined }> = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    handler(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing mock server port');
  const cfg: CliProxyConfig = { baseUrl: `http://127.0.0.1:${address.port}`, apiKeyEnv: KEY_ENV };
  return { cfg, requests };
}

function models(response: http.ServerResponse, ids = [OPUS_MODEL, SOL_MODEL]) {
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
}

describe('CLIProxyAPI URL and auth isolation', () => {
  it.each([
    ['http://127.0.0.1:8317/v1/', 'http://127.0.0.1:8317'],
    ['http://localhost:8317///', 'http://localhost:8317'],
    ['http://[::1]:8317/v1', 'http://[::1]:8317'],
    ['https://gateway.example/nested/v1///', 'https://gateway.example/nested'],
    ['https://gateway.example/', 'https://gateway.example'],
  ])('normalizes %s to the gateway root', (input, expected) => {
    expect(normalizeProxyUrl(input)).toBe(expected);
  });

  it.each([
    'relative/path', 'file:///tmp/socket', 'ftp://gateway.example',
    'http://gateway.example', 'http://192.168.1.5:8317',
    'https://user:secret@gateway.example', 'http://localhost:8317?api_key=secret',
    'https://gateway.example/#secret',
  ])('rejects unsafe gateway URL %s without echoing its contents', (url) => {
    expect(() => normalizeProxyUrl(url)).toThrow(/CLIProxyAPI|HTTP/);
    try { normalizeProxyUrl(url); } catch (error) { expect(String(error)).not.toContain('secret'); }
  });

  it('scopes gateway auth and every model alias without mutating the parent environment', () => {
    const inherited: NodeJS.ProcessEnv = {
      PATH: '/usr/bin', GIT_AUTHOR_NAME: 'AgentCraft Wren',
      [KEY_ENV]: ` ${KEY} `,
      ANTHROPIC_API_KEY: 'old-api-key', ANTHROPIC_AUTH_TOKEN: 'old-gateway-token',
      CLAUDE_CODE_OAUTH_TOKEN: 'old-oauth-token', ANTHROPIC_BASE_URL: 'https://old.example',
      ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer old-header',
      CLAUDE_CODE_API_KEY_HELPER_TTL_MS: '1',
      ANTHROPIC_MODEL: 'old-model', ANTHROPIC_DEFAULT_OPUS_MODEL: 'old-opus',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'old-sonnet', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'old-haiku',
      ANTHROPIC_SMALL_FAST_MODEL: 'old-fast',
      ...Object.fromEntries(Object.keys(PROVIDER_SWITCHES).map((name) => [name, '1'])),
    };
    const before = { ...inherited };
    const output = withProxyEnv(inherited, { baseUrl: 'http://127.0.0.1:8317/v1/', apiKeyEnv: KEY_ENV }, SOL_MODEL);
    expect(inherited).toEqual(before);
    expect(output).toMatchObject({
      PATH: '/usr/bin', GIT_AUTHOR_NAME: 'AgentCraft Wren',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317', ANTHROPIC_AUTH_TOKEN: KEY,
      ANTHROPIC_MODEL: SOL_MODEL, ANTHROPIC_DEFAULT_OPUS_MODEL: SOL_MODEL,
      ANTHROPIC_DEFAULT_SONNET_MODEL: SOL_MODEL, ANTHROPIC_DEFAULT_HAIKU_MODEL: SOL_MODEL,
      ANTHROPIC_SMALL_FAST_MODEL: SOL_MODEL,
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
    });
    for (const name of [...Object.keys(PROVIDER_SWITCHES), 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_API_KEY_HELPER_TTL_MS']) {
      expect(output).not.toHaveProperty(name);
    }
    expect(withProxyEnv(inherited, { baseUrl: 'http://localhost:8317', apiKeyEnv: KEY_ENV }, OPUS_MODEL).ANTHROPIC_MODEL).toBe(OPUS_MODEL);
    expect(output.ANTHROPIC_MODEL).toBe(SOL_MODEL); // another agent's aliases never leak back
  });

  it('requires the configured gateway key instead of falling back to inherited provider credentials', () => {
    expect(() => withProxyEnv({ ANTHROPIC_API_KEY: 'old-key', CLAUDE_CODE_OAUTH_TOKEN: 'old-oauth' }, { baseUrl: 'http://localhost:8317', apiKeyEnv: KEY_ENV }, SOL_MODEL)).toThrow(`Set ${KEY_ENV}`);
    expect(() => withProxyEnv({ [KEY_ENV]: '  ' }, { baseUrl: 'http://localhost:8317', apiKeyEnv: KEY_ENV }, SOL_MODEL)).toThrow(`Set ${KEY_ENV}`);
  });

  it('redacts configured and inherited credentials including JSON escapes and overlapping values', () => {
    const env = {
      [KEY_ENV]: 'local"proxy\\token', ANTHROPIC_API_KEY: 'provider-key',
      ANTHROPIC_AUTH_TOKEN: 'provider-key-longer', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret', OPENAI_API_KEY: 'openai-secret',
      PATH: '/usr/bin', EMPTY_API_KEY: ' ',
    };
    const cfg = { baseUrl: 'http://localhost:8317', apiKeyEnv: KEY_ENV };
    const raw = Object.values(env).join(' ');
    const redacted = redactProxySecrets(raw, cfg, env);
    for (const value of Object.values(env).filter((value) => value.includes('secret') || value.includes('key') || value.includes('token'))) expect(redacted).not.toContain(value);
    expect(redacted).not.toContain('-longer');
    expect(redacted).toContain('/usr/bin');
    const serialized = JSON.stringify({ error: `401 token ${env[KEY_ENV]}: ${env.ANTHROPIC_AUTH_TOKEN}` });
    expect(JSON.parse(redactProxySecrets(serialized, cfg, env))).toEqual({ error: '401 token [REDACTED]: [REDACTED]' });
    expect(redactProxySecrets('ordinary text', cfg, {})).toBe('ordinary text');
  });
});

describe('CLIProxyAPI model preflight (local HTTP fixtures)', () => {
  it('uses authenticated GET /v1/models and requires both exact model IDs without completions', async () => {
    const server = await modelServer((_request, response) => models(response));
    await checkProxyModels({ ...server.cfg, baseUrl: `${server.cfg.baseUrl}/nested/v1/` }, [OPUS_MODEL, SOL_MODEL, SOL_MODEL], { [KEY_ENV]: KEY });
    expect(server.requests).toEqual([{ method: 'GET', url: '/nested/v1/models', authorization: `Bearer ${KEY}` }]);
  });

  it('reports absent models once and never substitutes aliases or makes a completion request', async () => {
    const server = await modelServer((_request, response) => models(response, [OPUS_MODEL, 'gpt-6.1', 'sonnet']));
    await expect(checkProxyModels(server.cfg, [SOL_MODEL, SOL_MODEL], { [KEY_ENV]: KEY })).rejects.toThrow(`does not advertise: ${SOL_MODEL}.`);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.url).toBe('/v1/models');
  });

  it('refuses redirects so a model-list endpoint cannot forward the gateway credential', async () => {
    const destination = await modelServer((_request, response) => models(response));
    const source = await modelServer((_request, response) => {
      response.writeHead(307, { location: `${destination.cfg.baseUrl}/v1/models` }).end();
    });
    await expect(checkProxyModels(source.cfg, [SOL_MODEL], { [KEY_ENV]: KEY })).rejects.toThrow('Cannot reach CLIProxyAPI model list');
    expect(source.requests).toHaveLength(1);
    expect(destination.requests).toEqual([]);
  });

  it.each([401, 403, 500])('does not disclose an HTTP %i response body', async (status) => {
    const server = await modelServer((_request, response) => response.writeHead(status).end(`upstream credential ${KEY}, private-account@example.com`));
    const failure = await checkProxyModels(server.cfg, [SOL_MODEL], { [KEY_ENV]: KEY }).catch((error: Error) => error.message);
    expect(failure).toContain(`HTTP ${status}`);
    expect(failure).not.toContain(KEY);
    expect(failure).not.toContain('private-account');
  });

  it.each(['not JSON', '{}', '{"data":{}}', 'null'])('rejects malformed model list %s', async (body) => {
    const server = await modelServer((_request, response) => response.writeHead(200).end(body));
    await expect(checkProxyModels(server.cfg, [SOL_MODEL], { [KEY_ENV]: KEY })).rejects.toThrow('invalid model list');
  });

  it('fails before HTTP without a client key, and sanitizes transport errors', async () => {
    const request = vi.fn(async () => { throw new Error(`network error containing ${KEY}`); });
    const cfg = { baseUrl: 'http://localhost:8317', apiKeyEnv: KEY_ENV };
    await expect(checkProxyModels(cfg, [SOL_MODEL], {}, request as typeof fetch)).rejects.toThrow(`Set ${KEY_ENV}`);
    expect(request).not.toHaveBeenCalled();
    await expect(checkProxyModels(cfg, [SOL_MODEL], { [KEY_ENV]: KEY }, request as typeof fetch)).rejects.toThrow('Cannot reach CLIProxyAPI model list');
    expect(request).toHaveBeenCalledWith('http://localhost:8317/v1/models', expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }));
  });

  it('the backend blocks missing models without calling the SDK or storing credentials', async () => {
    const server = await modelServer((_request, response) => models(response, [OPUS_MODEL]));
    vi.stubEnv(KEY_ENV, KEY);
    const cfg = config(['--proxy-base-url', server.cfg.baseUrl, '--proxy-api-key-env', KEY_ENV]);
    const h = backend(cfg);
    expect(await h.instance.checkAuth()).toBe(false);
    expect(h.queryFn).not.toHaveBeenCalled();
    expect(h.fm.status.auth).toBe('failed');
    expect(h.fm.status.message).toContain('no fallback');
    expect(JSON.stringify({ config: cfg, state: h.fm.store.data, events: h.events })).not.toContain(KEY);
  });

  it('the backend accepts the advertised configured models without a provider-login probe', async () => {
    const server = await modelServer((_request, response) => models(response));
    vi.stubEnv(KEY_ENV, KEY);
    const h = backend(config(['--proxy-base-url', server.cfg.baseUrl, '--proxy-api-key-env', KEY_ENV]));
    expect(h.instance.name).toBe('cli-proxy');
    expect(await h.instance.checkAuth()).toBe(true);
    expect(h.queryFn).not.toHaveBeenCalled();
    expect(h.fm.status).toMatchObject({ auth: 'ok', account: 'CLIProxyAPI' });
    expect(h.fm.status.message).toContain(`wren ${OPUS_MODEL}`);
  });
});

describe('CLIProxyAPI agent configuration and override precedence', () => {
  it('defaults all six agents to the requested exact model assignments', () => {
    const cfg = config();
    expect(cfg.claude.workers).toEqual([...WORKER_IDS]);
    expect(cfg.profile).toBe('cli-proxy');
    expect(cfg.cliProxy).toEqual({ baseUrl: 'http://127.0.0.1:8317', apiKeyEnv: 'CLIPROXY_API_KEY' });
    expect(mapped(cfg)).toEqual({ marlow: OPUS_MODEL, wren: OPUS_MODEL, juniper: SOL_MODEL, kit: SOL_MODEL, rowan: SOL_MODEL, tove: SOL_MODEL });
  });

  it('keeps the original Claude backend defaults and three-worker team', () => {
    const cfg = config(['--backend', 'claude']);
    expect(cfg.claude.workers).toEqual(['juniper', 'kit', 'wren']);
    expect(cfg.claude.leadModel).toBe('opus');
    expect(cfg.claude.workerModel).toBe('sonnet');
    expect(cfg.claude.agentModels).toEqual({});
  });

  it('role/global flags override defaults including Wren, while specific agent maps remain authoritative', () => {
    expect(mapped(config(['--model', 'all-custom']))).toEqual(Object.fromEntries([LEAD_ID, ...WORKER_IDS].map((id) => [id, 'all-custom'])));
    const role = mapped(config(['--model', 'all-custom', '--lead-model', 'lead-custom', '--worker-model', 'workers-custom', '--agent-models', 'wren=wren-custom']));
    expect(role).toEqual({ marlow: 'lead-custom', wren: 'wren-custom', juniper: 'workers-custom', kit: 'workers-custom', rowan: 'workers-custom', tove: 'workers-custom' });
    // Per-agent specificity wins over the role/global flags, even when the map came from file.
    expect(mapped(config(['--model', 'all-custom'], {}, { claude: { agentModels: { wren: 'file-wren' } } })).wren).toBe('file-wren');
  });

  it('merges per-agent mappings file < environment < CLI independently for each agent', () => {
    const cfg = config(['--agent-models', 'wren=cli-wren,kit=cli-kit'], {
      AGENTCRAFT_AGENT_MODELS: JSON.stringify({ wren: 'env-wren', juniper: 'env-juniper' }),
    }, { claude: { agentModels: { marlow: 'file-marlow', wren: 'file-wren', juniper: 'file-juniper', rowan: 'file-rowan' } } });
    expect(mapped(cfg)).toEqual({ marlow: 'file-marlow', wren: 'cli-wren', kit: 'cli-kit', juniper: 'env-juniper', rowan: 'file-rowan', tove: SOL_MODEL });
  });

  it('applies URL/key-name and role-model precedence from file to environment to CLI', () => {
    const file = { cliProxy: { baseUrl: 'https://file.example/v1', apiKeyEnv: 'FILE_KEY' }, claude: { leadModel: 'file-lead', workerModel: 'file-worker' } };
    const env = { AGENTCRAFT_PROXY_BASE_URL: 'https://env.example/v1', AGENTCRAFT_PROXY_API_KEY_ENV: 'ENV_KEY', AGENTCRAFT_LEAD_MODEL: 'env-lead', AGENTCRAFT_WORKER_MODEL: 'env-worker' };
    expect(config([], {}, file).cliProxy).toEqual({ baseUrl: 'https://file.example', apiKeyEnv: 'FILE_KEY' });
    expect(config([], env, file).cliProxy).toEqual({ baseUrl: 'https://env.example', apiKeyEnv: 'ENV_KEY' });
    const cfg = config(['--proxy-base-url', 'http://localhost:9999/v1', '--proxy-api-key-env', 'CLI_KEY', '--lead-model', 'cli-lead', '--worker-model', 'cli-worker'], env, file);
    expect(cfg.cliProxy).toEqual({ baseUrl: 'http://localhost:9999', apiKeyEnv: 'CLI_KEY' });
    expect(mapped(cfg).marlow).toBe('cli-lead');
    expect(mapped(cfg).wren).toBe('cli-worker');
    expect(mapped(config([], env, file)).wren).toBe('env-worker');
  });

  it.each(['unknown=model', 'wren=', '{"wren":42}', '{"wren":"a\\nb"}', '[]', '{bad json'])('rejects invalid explicit agent map %s', (value) => {
    expect(() => config(['--agent-models', value])).toThrow(/agent|model/);
  });

  it('rejects OAuth-login mode and raw-key CLI flags for the proxy backend', () => {
    expect(() => config(['--use-claude-login'])).toThrow('cannot be combined');
    expect(() => config(['--proxy-api-key-env', 'not-an-env-name'])).toThrow('environment variable name');
    expect(() => config(['--proxy-api-key', KEY])).toThrow('unknown option');
  });
});
