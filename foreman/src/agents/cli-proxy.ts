// CLIProxyAPI's Anthropic-compatible gateway keeps the real Agent SDK tool/session loop.
// The proxy owns translation to each provider (GPT-6.1 tools require a Responses upstream).
import { PROVIDER_SWITCHES } from './claude/auth.js';

export interface CliProxyConfig {
  /** Gateway root, not the OpenAI /v1 base URL. */
  baseUrl: string;
  /** Read at runtime; never put keys in config/state files or process arguments. */
  apiKeyEnv: string;
}

export const OPUS_MODEL = 'claude-opus-5-5';
export const SOL_MODEL = 'gpt-6.1-sol';

/** Scrub known credentials before proxy/SDK text reaches logs, persisted state or the UI. */
export function redactProxySecrets(text: string, cfg: CliProxyConfig, env: NodeJS.ProcessEnv = process.env): string {
  const names = [cfg.apiKeyEnv, ...Object.keys(env).filter((name) =>
    /(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|OAUTH_TOKEN|SECRET_ACCESS_KEY|SESSION_TOKEN|CLIENT_SECRET|PASSWORD)$/.test(name))];
  const secrets = new Set<string>();
  for (const name of names) {
    const value = env[name]?.trim();
    if (!value) continue;
    secrets.add(value);
    // The backend also scrubs JSON-serialized SDK messages; quoted/backslashed tokens must
    // be removed there before parsing the message again.
    secrets.add(JSON.stringify(value).slice(1, -1));
  }
  let clean = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) clean = clean.split(secret).join('[REDACTED]');
  return clean;
}

export function normalizeProxyUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('CLIProxyAPI base URL must be an absolute HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('CLIProxyAPI base URL must be HTTP(S), without credentials, query or fragment');
  }
  // A local HTTP gateway is the normal CLIProxyAPI setup. Remote gateways must use TLS.
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Remote CLIProxyAPI gateways must use HTTPS');
  }
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  return url.toString().replace(/\/$/, '');
}

function proxyKey(cfg: CliProxyConfig, env: NodeJS.ProcessEnv): string {
  const key = env[cfg.apiKeyEnv]?.trim();
  if (!key) throw new Error(`Set ${cfg.apiKeyEnv} to your CLIProxyAPI client API key, then restart the Foreman`);
  return key;
}

/** Scope gateway auth and model aliases to one SDK child; never mutate process.env. */
export function withProxyEnv(base: NodeJS.ProcessEnv, cfg: CliProxyConfig, model: string): NodeJS.ProcessEnv {
  const key = proxyKey(cfg, base);
  const out = { ...base };
  for (const name of [...Object.keys(PROVIDER_SWITCHES), 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_API_KEY_HELPER_TTL_MS']) delete out[name];
  Object.assign(out, {
    ANTHROPIC_BASE_URL: normalizeProxyUrl(cfg.baseUrl),
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
  });
  return out;
}

/** Read-only preflight. Never makes a billable completion or substitutes another model. */
export async function checkProxyModels(
  cfg: CliProxyConfig, models: string[], env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch,
): Promise<void> {
  const baseUrl = normalizeProxyUrl(cfg.baseUrl);
  const key = proxyKey(cfg, env);
  let response: Response;
  try {
    response = await fetchFn(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
  } catch {
    throw new Error('Cannot reach CLIProxyAPI model list; check the gateway URL, TLS and that the proxy is running');
  }
  // Do not echo server bodies: proxy errors may contain credentials or upstream account data.
  if (!response.ok) throw new Error(`CLIProxyAPI model check returned HTTP ${response.status}; check the client API key and gateway configuration`);
  let body: unknown;
  try { body = await response.json(); } catch { throw new Error('CLIProxyAPI returned an invalid model list'); }
  if (!body || typeof body !== 'object' || !('data' in body) || !Array.isArray(body.data)) {
    throw new Error('CLIProxyAPI returned an invalid model list (expected data[])');
  }
  const ids = new Set(body.data.map((m: unknown) => m && typeof m === 'object' && 'id' in m ? m.id : undefined));
  const missing = [...new Set(models)].filter((model) => !ids.has(model));
  if (missing.length) throw new Error(`CLIProxyAPI does not advertise: ${missing.join(', ')}. Configure these models or use explicit agent-model overrides; no fallback was made`);
}
