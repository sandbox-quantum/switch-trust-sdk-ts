import {
  GuardrailsConfig,
  SwitchTrustGuardrailsError,
  buildGuardrailsConfig,
  configureGuardrails,
  detectProvider,
  resolveFromEnv,
  checkOptionalGuardrailsParams,
} from '../src/guardrails.js';
import * as core from '../src/core.js';
import { SwitchTrustClient } from '../src/core.js';

const GATEWAY = 'https://gw.example.com';
const API_KEY = 'grl_sk_testapikey';

// ---------------------------------------------------------------------------
// checkOptionalGuardrailsParams
// ---------------------------------------------------------------------------

describe('checkOptionalGuardrailsParams', () => {
  it.each([
    ['all null', null, null, false, null],
    ['all provided', 'gw', 'ak', true, null],
    ['only gatewayUrl', 'gw', null, null, 'Missing: api_key'],
  ] as const)('%s', (_label, gw, ak, expected, errorMatch) => {
    if (errorMatch) {
      expect(() => checkOptionalGuardrailsParams(gw, ak)).toThrow(errorMatch);
    } else {
      expect(checkOptionalGuardrailsParams(gw, ak)).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

describe('detectProvider', () => {
  it.each([
    ['GOOGLE_API_KEY', 'google'],
    ['ANTHROPIC_API_KEY', 'anthropic'],
    ['OPENAI_API_KEY', 'openai'],
  ] as const)('returns %s for %s', (envVar: string, expected: string) => {
    process.env[envVar] = 'test-key-value';
    expect(detectProvider()).toBe(expected);
    delete process.env[envVar];
  });

  it('returns null when no env vars are set', () => {
    expect(detectProvider()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildGuardrailsConfig — provider path mapping
// ---------------------------------------------------------------------------

describe('buildGuardrailsConfig', () => {
  it.each([
    ['openai', '/openai'],
    ['anthropic', '/anthropic'],
    ['google', '/gemini'],
  ] as const)('builds config with %s → path %s', (provider, expectedPath) => {
    const cfg = buildGuardrailsConfig(GATEWAY, API_KEY, provider);
    expect(cfg.baseUrl).toBe(GATEWAY + expectedPath);
    expect(cfg.headers['X-FlintAI-API-Key']).toBe(API_KEY);
  });

  it('includes X-Guardrails-Policy-Id when policyId is provided', () => {
    const cfg = buildGuardrailsConfig(GATEWAY, API_KEY, 'openai', 'pol-1');
    expect(cfg.headers['X-Guardrails-Policy-Id']).toBe('pol-1');
  });

  it('does not touch global client state', () => {
    core.setClient(null);
    buildGuardrailsConfig(GATEWAY, API_KEY, 'openai');
    expect(core.getClient()?.guardrailsConfig).toBeUndefined();
  });

  it('rejects unsupported provider', () => {
    expect(() => buildGuardrailsConfig(GATEWAY, API_KEY, 'cohere' as Parameters<typeof buildGuardrailsConfig>[2])).toThrow('Unsupported provider');
  });

  it('rejects malformed URL', () => {
    expect(() => buildGuardrailsConfig('not-a-url', API_KEY, 'openai')).toThrow('gateway_url must be a valid URL');
  });

  it('null provider → baseUrl equals gatewayUrl', () => {
    const cfg = buildGuardrailsConfig(GATEWAY, API_KEY, null);
    expect(cfg.baseUrl).toBe(GATEWAY);
    expect(cfg.provider).toBeNull();
  });

  it('rejects empty apiKey', () => {
    expect(() => buildGuardrailsConfig(GATEWAY, '')).toThrow('api_key must be a non-empty string');
  });
});

// ---------------------------------------------------------------------------
// Gateway URL validation
// ---------------------------------------------------------------------------

describe('gateway URL validation', () => {
  it('rejects HTTP for non-loopback hosts', () => {
    expect(() => buildGuardrailsConfig('http://remote.example.com', API_KEY)).toThrow('gateway_url must use https://');
  });

  it('allows HTTP for localhost with warning when allowInsecureGateway is set', () => {
    const warnSpy = vi.spyOn(console, 'warn');
    const cfg = buildGuardrailsConfig('http://localhost:8080', API_KEY, undefined, undefined, undefined, undefined, true);
    expect(cfg.baseUrl).toBe('http://localhost:8080');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('plaintext HTTP'));
  });

  it('allows HTTP for 127.0.0.1 when allowInsecureGateway is set', () => {
    const cfg = buildGuardrailsConfig('http://127.0.0.1:8080', API_KEY, undefined, undefined, undefined, undefined, true);
    expect(cfg.baseUrl).toBe('http://127.0.0.1:8080');
  });

  it('rejects loopback without allowInsecureGateway', () => {
    expect(() => buildGuardrailsConfig('http://localhost:8080', API_KEY)).toThrow('requires allowInsecureGateway=true');
  });

  it('rejects https loopback without allowInsecureGateway', () => {
    expect(() => buildGuardrailsConfig('https://localhost:8080', API_KEY)).toThrow('requires allowInsecureGateway=true');
  });

  it('rejects hosts not in default allowlist', () => {
    delete process.env.SWITCH_TRUST_ALLOWED_GATEWAY_HOSTS;
    expect(() => buildGuardrailsConfig('https://evil.example.com', API_KEY)).toThrow('not in the allowed gateway hosts');
  });

  it('allows api.flintai.dev by default', () => {
    delete process.env.SWITCH_TRUST_ALLOWED_GATEWAY_HOSTS;
    const cfg = buildGuardrailsConfig('https://api.flintai.dev', API_KEY);
    expect(cfg.baseUrl).toBe('https://api.flintai.dev');
  });

  it('allows api.switchagents.ai by default', () => {
    delete process.env.SWITCH_TRUST_ALLOWED_GATEWAY_HOSTS;
    const cfg = buildGuardrailsConfig('https://api.switchagents.ai', API_KEY);
    expect(cfg.baseUrl).toBe('https://api.switchagents.ai');
  });

  it('allows custom hosts via SWITCH_TRUST_ALLOWED_GATEWAY_HOSTS', () => {
    process.env.SWITCH_TRUST_ALLOWED_GATEWAY_HOSTS = 'custom.host';
    const cfg = buildGuardrailsConfig('https://custom.host', API_KEY);
    expect(cfg.baseUrl).toBe('https://custom.host');
  });

  it('SWITCH_TRUST_ALLOWED_GATEWAY_HOSTS takes precedence over legacy FLINTAI_ALLOWED_GATEWAY_HOSTS', () => {
    process.env.FLINTAI_ALLOWED_GATEWAY_HOSTS = 'custom.host';
    process.env.SWITCH_TRUST_ALLOWED_GATEWAY_HOSTS = 'gw.corp.com';
    expect(() => buildGuardrailsConfig('https://custom.host', API_KEY)).toThrow('not in the allowed gateway hosts');
    delete process.env.FLINTAI_ALLOWED_GATEWAY_HOSTS;
  });

  it('allows any host with wildcard when allowInsecureGateway is set', () => {
    process.env.SWITCH_TRUST_ALLOWED_GATEWAY_HOSTS = '*';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = buildGuardrailsConfig('https://anything.example.com', API_KEY, undefined, undefined, undefined, undefined, true);
    expect(cfg.baseUrl).toBe('https://anything.example.com');
  });

  it('rejects wildcard without allowInsecureGateway', () => {
    process.env.SWITCH_TRUST_ALLOWED_GATEWAY_HOSTS = '*';
    expect(() => buildGuardrailsConfig('https://anything.example.com', API_KEY)).toThrow('requires allowInsecureGateway=true');
  });

  it('warns when wildcard arbitrary-host mode is enabled', () => {
    process.env.SWITCH_TRUST_ALLOWED_GATEWAY_HOSTS = '*';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    buildGuardrailsConfig('https://anything.example.com', API_KEY, undefined, undefined, undefined, undefined, true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('disables the gateway host allowlist'));
  });
});

// ---------------------------------------------------------------------------
// policy_id header behavior
// ---------------------------------------------------------------------------

describe('policy_id header', () => {
  it.each([
    ['pol-1', true],
    [null, false],
  ] as const)('policy_id=%s → header present=%s', (policyId, shouldBePresent) => {
    const cfg = buildGuardrailsConfig(GATEWAY, API_KEY, 'openai', policyId);
    if (shouldBePresent) {
      expect(cfg.headers['X-Guardrails-Policy-Id']).toBe(policyId);
    } else {
      expect('X-Guardrails-Policy-Id' in cfg.headers).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// agent_id header behavior
// ---------------------------------------------------------------------------

describe('agent_id header', () => {
  it.each([
    ['my-agent', true],
    [null, false],
  ] as const)('agent_id=%s → header present=%s', (agentId, shouldBePresent) => {
    const cfg = buildGuardrailsConfig(GATEWAY, API_KEY, 'openai', null, agentId);
    if (shouldBePresent) {
      expect(cfg.headers['X-Agent-Id']).toBe(agentId);
      expect(cfg.agentId).toBe(agentId);
    } else {
      expect('X-Agent-Id' in cfg.headers).toBe(false);
      expect(cfg.agentId).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// GuardrailsConfig.clear()
// ---------------------------------------------------------------------------

describe('GuardrailsConfig.clear()', () => {
  it('resets all fields to empty/null', () => {
    const cfg = new GuardrailsConfig({
      baseUrl: GATEWAY + '/openai',
      headers: { 'X-FlintAI-API-Key': API_KEY },
      provider: 'openai',
      gatewayUrl: GATEWAY,
      policyId: 'pol-1',
      agentId: 'my-agent',
    });

    cfg.clear();

    expect(cfg.baseUrl).toBe('');
    expect(cfg.gatewayUrl).toBe('');
    expect(cfg.provider).toBeNull();
    expect(cfg.policyId).toBeNull();
    expect(cfg.agentId).toBeNull();
    expect(cfg.headers).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// GuardrailsConfig.toString() masks credentials
// ---------------------------------------------------------------------------

describe('GuardrailsConfig.toString()', () => {
  it.each([
    ['grl_sk_1234567890', 'gr***', 'grl_sk_1234567890', 'masks long values to first 2 chars + ***'],
    ['ab', '***', 'ab', 'masks short values (<=2 chars) to ***'],
  ] as const)('%s', (rawKey, maskedPattern, rawPattern, _label) => {
    const cfg = new GuardrailsConfig({
      baseUrl: GATEWAY + '/openai',
      headers: { 'X-FlintAI-API-Key': rawKey },
      provider: 'openai',
      gatewayUrl: GATEWAY,
    });

    const str = cfg.toString();
    expect(str).toContain(maskedPattern);
    expect(str).not.toContain(rawPattern);
  });
});

// ---------------------------------------------------------------------------
// configureGuardrails stores config on client
// ---------------------------------------------------------------------------

describe('configureGuardrails', () => {
  it('stores config on client', () => {
    core.setClient(new SwitchTrustClient('openai'));
    const cfg = configureGuardrails(GATEWAY, API_KEY);
    expect(core.getClient()!.guardrailsConfig).toBe(cfg);
  });

  it('uses client provider when provider not passed explicitly', () => {
    core.setClient(new SwitchTrustClient('anthropic'));
    const cfg = configureGuardrails(GATEWAY, API_KEY);
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.baseUrl).toContain('/anthropic');
  });

  it('falls through to detectProvider when client provider is null', () => {
    core.setClient(new SwitchTrustClient(null));
    process.env.OPENAI_API_KEY = 'sk-detect-test';
    const cfg = configureGuardrails(GATEWAY, API_KEY);
    expect(cfg.provider).toBe('openai');
    delete process.env.OPENAI_API_KEY;
  });

  it('leaves provider null and uses gateway url as base when no provider is detectable', () => {
    core.setClient(new SwitchTrustClient(null));
    const cfg = configureGuardrails(GATEWAY, API_KEY);
    expect(cfg.provider).toBeNull();
    expect(cfg.baseUrl).toBe(GATEWAY);
  });

  it('warns when called before switchTrust.init (no client)', () => {
    core.setClient(null);
    const warnSpy = vi.spyOn(console, 'warn');
    configureGuardrails(GATEWAY, API_KEY);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('called before switchTrust.init'));
  });

  it('normalizes trailing slash on gateway url before appending path', () => {
    core.setClient(new SwitchTrustClient('openai'));
    const cfg = configureGuardrails(GATEWAY + '/', API_KEY);
    expect(cfg.baseUrl).toBe(GATEWAY + '/openai');
  });

  it('throws on unsupported provider', () => {
    core.setClient(new SwitchTrustClient('openai'));
    expect(() => configureGuardrails(GATEWAY, API_KEY, 'cohere' as Parameters<typeof configureGuardrails>[2])).toThrow('Unsupported provider');
  });

  it.each([
    ['bad', API_KEY, 'gateway_url must be a valid URL'],
    [GATEWAY, '', 'api_key must be a non-empty string'],
  ] as const)('rejects invalid params: gateway=%s api_key=%s', (gatewayUrl, apiKey, errorFragment) => {
    core.setClient(new SwitchTrustClient(null));
    expect(() => configureGuardrails(gatewayUrl, apiKey)).toThrow(errorFragment);
  });

  it('attaches policy_id to headers when no provider and policy_id provided', () => {
    core.setClient(new SwitchTrustClient(null));
    const cfg = configureGuardrails(GATEWAY, API_KEY, null, 'pol-99');
    expect(cfg.headers['X-Guardrails-Policy-Id']).toBe('pol-99');
    expect(cfg.policyId).toBe('pol-99');
  });
});

// ---------------------------------------------------------------------------
// detectProvider — multiple keys
// ---------------------------------------------------------------------------

describe('detectProvider multiple keys', () => {
  it('throws when multiple provider API keys are set', () => {
    process.env.OPENAI_API_KEY = 'sk-openai';
    process.env.ANTHROPIC_API_KEY = 'sk-anthropic';
    expect(() => detectProvider()).toThrow('Multiple provider API keys detected');
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });
});

// ---------------------------------------------------------------------------
// resolveFromEnv
// ---------------------------------------------------------------------------

describe('resolveFromEnv', () => {
  it('reads SWITCH_TRUST_* env vars', () => {
    process.env.SWITCH_TRUST_GATEWAY_URL = 'https://env.example.com';
    process.env.SWITCH_TRUST_API_KEY = 'env-api-key';
    process.env.SWITCH_TRUST_POLICY_ID = 'env-pol-1';

    const [gw, ak, pid] = resolveFromEnv();
    expect(gw).toBe('https://env.example.com');
    expect(ak).toBe('env-api-key');
    expect(pid).toBe('env-pol-1');
  });

  it('reads legacy FLINTAI_* fallback env vars', () => {
    process.env.FLINTAI_GATEWAY_URL = 'https://env.example.com';
    process.env.FLINTAI_API_KEY = 'env-api-key';
    process.env.FLINTAI_POLICY_ID = 'env-pol-1';

    const [gw, ak, pid] = resolveFromEnv();
    expect(gw).toBe('https://env.example.com');
    expect(ak).toBe('env-api-key');
    expect(pid).toBe('env-pol-1');
  });

  it('SWITCH_TRUST_* takes precedence over legacy FLINTAI_*', () => {
    process.env.FLINTAI_GATEWAY_URL = 'https://legacy.env.com';
    process.env.SWITCH_TRUST_GATEWAY_URL = 'https://env.example.com';

    const [gw] = resolveFromEnv();
    expect(gw).toBe('https://env.example.com');
  });

  it('explicit values win over env vars', () => {
    process.env.FLINTAI_GATEWAY_URL = 'https://env.example.com';
    process.env.FLINTAI_API_KEY = 'env-api-key';
    process.env.FLINTAI_POLICY_ID = 'env-pol-1';

    const [gw, ak, pid] = resolveFromEnv('https://explicit.example.com', 'explicit-api-key', 'explicit-pol-99');
    expect(gw).toBe('https://explicit.example.com');
    expect(ak).toBe('explicit-api-key');
    expect(pid).toBe('explicit-pol-99');
  });

  it('returns all null when no env vars are set', () => {
    const [gw, ak, pid] = resolveFromEnv();
    expect(gw).toBeNull();
    expect(ak).toBeNull();
    expect(pid).toBeNull();
  });

  it('returns partial results when only FLINTAI_GATEWAY_URL is set', () => {
    process.env.FLINTAI_GATEWAY_URL = 'https://partial.example.com';

    const [gw, ak, pid] = resolveFromEnv();
    expect(gw).toBe('https://partial.example.com');
    expect(ak).toBeNull();
    expect(pid).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// configureGuardrails edge cases
// ---------------------------------------------------------------------------

describe('configureGuardrails edge cases', () => {
  it('warns when called without any client', () => {
    core.setClient(null);
    const warnSpy = vi.spyOn(console, 'warn');
    const cfg = configureGuardrails(GATEWAY, API_KEY);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('called before switchTrust.init'));
    expect(cfg).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SwitchTrustGuardrailsError
// ---------------------------------------------------------------------------

describe('SwitchTrustGuardrailsError', () => {
  it('is an instance of Error', () => {
    const err = new SwitchTrustGuardrailsError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SwitchTrustGuardrailsError');
    expect(err.message).toBe('test');
  });
});
