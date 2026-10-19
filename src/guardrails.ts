import { createRequire } from 'node:module';
import * as core from './core.js';

const require = createRequire(import.meta.url);

export class SwitchTrustGuardrailsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SwitchTrustGuardrailsError';
  }
}

let _optOutWarned = false;

// Test hook: reset the once-per-process latch.
export function resetOptOutWarned(warned = false): void {
  _optOutWarned = warned;
}

// Audit signal (once per process) so the opt-out is not a silent fail-open.
export function warnGuardrailsDisabled(source: string, config: GuardrailsConfig | null): void {
  if (_optOutWarned) return;
  _optOutWarned = true;
  const agent = config?.agentName ?? config?.agentId ?? process.env.AGENT_NAME ?? process.env.AGENT_ID ?? 'unknown';
  const posture = config
    ? 'guardrails config is present, but enforcement checks (fail-closed, base-URL verification) are OFF'
    : 'NO guardrails config is active — LLM traffic is NOT protected by the gateway';
  console.warn(
    `Switch Trust SDK: SECURITY CONTROL DISABLED — ${source} invoked with requireGuardrails=false. ` +
      `${posture}. agent=${JSON.stringify(agent)}. ` +
      'This deployment is running without the SDK guardrails guarantee.'
  );
}

export type Provider = 'openai' | 'anthropic' | 'google';

export const PROVIDER_PATH_MAP: Record<Provider, string> = {
  openai: '/openai',
  google: '/gemini',
  anthropic: '/anthropic',
};

const ENV_VARS: Record<string, string> = {
  gatewayUrl: 'SWITCH_TRUST_GATEWAY_URL',
  apiKey: 'SWITCH_TRUST_API_KEY',
  policyId: 'SWITCH_TRUST_POLICY_ID',
};

// Read when the SWITCH_TRUST_* variable above is unset, so existing FLINTAI_*
// deployments keep working. TODO: Remove as fast-follow
const ENV_VARS_FALLBACK: Record<string, string> = {
  gatewayUrl: 'FLINTAI_GATEWAY_URL',
  apiKey: 'FLINTAI_API_KEY',
  policyId: 'FLINTAI_POLICY_ID',
};

const _ALLOWED_HOSTS_ENV = 'SWITCH_TRUST_ALLOWED_GATEWAY_HOSTS';
const _ALLOWED_HOSTS_ENV_FALLBACK = 'FLINTAI_ALLOWED_GATEWAY_HOSTS';
const _DEFAULT_ALLOWED_GATEWAY_HOSTS: ReadonlySet<string> = new Set(['api.switchagents.ai', 'api.flintai.dev', 'app.flintai.dev']);

function _isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

let _dotenvLoaded = false;

export function resetDotenvLoaded(loaded = false): void {
  _dotenvLoaded = loaded;
}

export class GuardrailsConfig {
  baseUrl: string;
  headers: Record<string, string>;
  provider: Provider | null;
  gatewayUrl: string;
  policyId: string | null;
  agentId: string | null;
  agentName: string | null;

  constructor(opts: {
    baseUrl: string;
    headers: Record<string, string>;
    provider: Provider | null;
    gatewayUrl: string;
    policyId?: string | null;
    agentId?: string | null;
    agentName?: string | null;
  }) {
    this.baseUrl = opts.baseUrl;
    this.headers = opts.headers;
    this.provider = opts.provider;
    this.gatewayUrl = opts.gatewayUrl;
    this.policyId = opts.policyId ?? null;
    this.agentId = opts.agentId ?? null;
    this.agentName = opts.agentName ?? null;
  }

  clear(): void {
    this.headers = {};
    this.baseUrl = '';
    this.gatewayUrl = '';
    this.provider = null;
    this.policyId = null;
    this.agentId = null;
    this.agentName = null;
  }

  toString(): string {
    const masked: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.headers)) {
      masked[k] = v.length > 2 ? v.slice(0, 2) + '***' : '***';
    }
    return `GuardrailsConfig(provider=${JSON.stringify(this.provider)}, gateway_url=${JSON.stringify(this.gatewayUrl)}, headers=${JSON.stringify(
      masked
    )}, policy_id=${JSON.stringify(this.policyId)})`;
  }
}

export function detectProvider(): Provider | null {
  const mapping: Array<[string, Provider]> = [
    ['GOOGLE_API_KEY', 'google'],
    ['OPENAI_API_KEY', 'openai'],
    ['ANTHROPIC_API_KEY', 'anthropic'],
  ];

  const found: Array<[string, Provider]> = [];
  for (const [envVar, provider] of mapping) {
    if (process.env[envVar]) {
      found.push([envVar, provider]);
    }
  }

  if (found.length > 1) {
    const names = found
      .map(([, v]) => v)
      .sort()
      .join(', ');
    throw new Error(`Multiple provider API keys detected (${names}). Pass provider= explicitly to disambiguate.`);
  }

  return found.length === 1 ? found[0][1] : null;
}

function validateGuardrailsParams(gatewayUrl: string, apiKey: string, allowInsecureGateway = false): string {
  let parsed: URL;
  try {
    parsed = new URL(gatewayUrl || '');
  } catch {
    throw new Error(`gateway_url must be a valid URL with https:// (http:// allowed only for localhost); got: ${JSON.stringify(gatewayUrl)}`);
  }

  const hostname = parsed.hostname;
  const isLoopback = _isLoopback(hostname);

  // Loopback redirects credentials to a local endpoint; only allow it under an
  // explicit programmatic opt-in so a .env-supplied localhost URL can't do it.
  if (isLoopback && !allowInsecureGateway) {
    throw new Error(`gateway_url ${JSON.stringify(gatewayUrl)} targets a loopback host; this requires allowInsecureGateway=true (local development only).`);
  }

  if (parsed.protocol === 'https:') {
    // OK
  } else if (parsed.protocol === 'http:' && isLoopback) {
    console.warn(`gateway_url ${JSON.stringify(gatewayUrl)} uses plaintext HTTP; API keys will be sent unencrypted.`);
  } else {
    throw new Error(`gateway_url must use https:// (http:// is allowed only for localhost); got: ${JSON.stringify(gatewayUrl)}`);
  }

  if (!hostname) {
    throw new Error(`gateway_url must contain a valid hostname, got: ${JSON.stringify(gatewayUrl)}`);
  }

  const allowedRaw = process.env[_ALLOWED_HOSTS_ENV] ?? process.env[_ALLOWED_HOSTS_ENV_FALLBACK];
  let allowed: Set<string>;
  if (allowedRaw != null) {
    allowed = new Set(
      allowedRaw
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean)
    );
  } else {
    allowed = new Set([..._DEFAULT_ALLOWED_GATEWAY_HOSTS].map((h) => h.toLowerCase()));
  }

  if (allowed.has('*')) {
    if (!allowInsecureGateway) {
      throw new Error(
        `${_ALLOWED_HOSTS_ENV}='*' disables the gateway host allowlist and requires allowInsecureGateway=true to be set in code. ` +
          `Set an explicit comma-separated host list instead, or pass allowInsecureGateway=true for local development.`
      );
    }
    if (!isLoopback) {
      console.warn(
        `${_ALLOWED_HOSTS_ENV}='*' disables the gateway host allowlist: gateway_url host ${JSON.stringify(hostname)} ` +
          `will receive the Switch Trust API key, provider credentials, and all prompt/response traffic. ` +
          `Set an explicit host allowlist outside local development.`
      );
    }
  } else if (!isLoopback && !allowed.has(hostname.toLowerCase())) {
    throw new Error(
      `gateway_url hostname ${JSON.stringify(hostname)} is not in the allowed ` +
        `gateway hosts [${[...allowed]
          .sort()
          .map((h) => JSON.stringify(h))
          .join(', ')}]. ` +
        `Set ${_ALLOWED_HOSTS_ENV} to override (comma-separated hosts).`
    );
  }

  if (!apiKey) {
    throw new Error('api_key must be a non-empty string');
  }

  return gatewayUrl.replace(/\/+$/, '');
}

export function checkOptionalGuardrailsParams(gatewayUrl: string | null | undefined, apiKey: string | null | undefined): boolean {
  if (gatewayUrl == null && apiKey == null) return false;

  const missing: string[] = [];
  if (gatewayUrl == null) missing.push('gateway_url');
  if (apiKey == null) missing.push('api_key');

  if (missing.length > 0) {
    throw new Error(`gateway_url and api_key are both required when providing guardrails config. Missing: ${missing.join(', ')}`);
  }
  return true;
}

export function resolveFromEnv(
  gatewayUrl?: string | null,
  apiKey?: string | null,
  policyId?: string | null,
  loadDotenv: boolean | string = false
): [string | null, string | null, string | null] {
  // A .env file is only read when loadDotenv is truthy (true => cwd/.env, a
  // string => that path), so an untrusted .env in the working directory cannot
  // influence gateway configuration. Real environment variables are always read.
  // SWITCH_TRUST_* takes precedence over legacy FLINTAI_* when both are set.
  if (loadDotenv && !_dotenvLoaded) {
    _dotenvLoaded = true;
    try {
      const dotenv = require('dotenv') as { config: (opts?: { path?: string }) => void };
      dotenv.config(typeof loadDotenv === 'string' ? { path: loadDotenv } : undefined);
    } catch {
      // dotenv not installed, skip
    }
  }

  return [
    gatewayUrl ?? (process.env[ENV_VARS.gatewayUrl] || process.env[ENV_VARS_FALLBACK.gatewayUrl] || null),
    apiKey ?? (process.env[ENV_VARS.apiKey] || process.env[ENV_VARS_FALLBACK.apiKey] || null),
    policyId ?? (process.env[ENV_VARS.policyId] || process.env[ENV_VARS_FALLBACK.policyId] || null),
  ];
}

export function buildGuardrailsConfig(
  gatewayUrl: string,
  apiKey: string,
  provider?: Provider | null,
  policyId?: string | null,
  agentId?: string | null,
  agentName?: string | null,
  allowInsecureGateway = false
): GuardrailsConfig {
  gatewayUrl = validateGuardrailsParams(gatewayUrl, apiKey, allowInsecureGateway);

  if (provider && !(provider in PROVIDER_PATH_MAP)) {
    throw new Error(`Unsupported provider: ${JSON.stringify(provider)}. Supported: ${Object.keys(PROVIDER_PATH_MAP).join(', ')}`);
  }

  const baseUrl = provider ? gatewayUrl + PROVIDER_PATH_MAP[provider] : gatewayUrl;

  const headers: Record<string, string> = {
    'X-FlintAI-API-Key': apiKey,
  };

  if (policyId != null) {
    headers['X-Guardrails-Policy-Id'] = policyId;
  }
  if (agentId != null) {
    headers['X-Agent-Id'] = agentId;
  }
  if (agentName != null) {
    headers['X-Agent-Name'] = agentName;
  }

  return new GuardrailsConfig({
    baseUrl,
    headers,
    provider: provider ?? null,
    gatewayUrl,
    policyId: policyId ?? null,
    agentId: agentId ?? null,
    agentName: agentName ?? null,
  });
}

export function configureGuardrails(
  gatewayUrl: string,
  apiKey: string,
  provider?: Provider | null,
  policyId?: string | null,
  agentId?: string | null,
  agentName?: string | null,
  allowInsecureGateway = false
): GuardrailsConfig {
  const client = core.getClient();

  if (provider == null && client) {
    provider = client.provider;
  }
  if (provider == null) {
    provider = detectProvider();
  }

  const config = buildGuardrailsConfig(gatewayUrl, apiKey, provider, policyId, agentId, agentName, allowInsecureGateway);

  if (client) {
    client.guardrailsConfig = config;
  } else {
    console.warn(
      'configureGuardrails() called before switchTrust.init(). The config will not be attached to any client. Call switchTrust.init() first, or pass this config manually.'
    );
  }

  return config;
}
