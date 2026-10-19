import { describe, it, expect, vi } from 'vitest';
import { init, shutdown, registerPlugin, status, VERSION } from '../src/index.js';
import { SwitchTrustPlugin } from '../src/plugins/index.js';
import { SwitchTrustGuardrailsError } from '../src/guardrails.js';

class NoopPlugin extends SwitchTrustPlugin {}

describe('switch trust public API', () => {
  it('throws when registering plugin before init', () => {
    shutdown();
    expect(() => registerPlugin(new NoopPlugin())).toThrow(/Call switchTrust\.init/);
  });

  it('initializes with provider', () => {
    const client = init({ provider: 'anthropic', requireGuardrails: false });
    expect(client.provider).toBe('anthropic');
  });

  it('double init shuts down previous client', () => {
    class MockPlugin extends SwitchTrustPlugin {
      name = 'mock';
      onShutdown = vi.fn();
    }

    const plugin = new MockPlugin();
    const first = init({ requireGuardrails: false });
    first.registerPlugin(plugin);

    init({ requireGuardrails: false });

    expect(plugin.onShutdown).toHaveBeenCalledOnce();
  });

  it('VERSION is a non-empty string', () => {
    expect(typeof VERSION).toBe('string');
    expect(VERSION.length).toBeGreaterThan(0);
  });

  it('shutdown is idempotent', () => {
    init({ requireGuardrails: false });
    expect(() => {
      shutdown();
      shutdown();
    }).not.toThrow();
  });

  it('re-inits after shutdown', () => {
    const first = init({ requireGuardrails: false });
    expect(first).not.toBeNull();

    shutdown();

    const second = init({ requireGuardrails: false });
    expect(second).not.toBeNull();
  });

  it('init with guardrails params sets headers', () => {
    const client = init({
      gatewayUrl: 'https://gw.example.com',
      apiKey: 'grl_key',
    });
    expect(client.guardrailsConfig).not.toBeNull();
    expect(client.guardrailsConfig!.headers['X-FlintAI-API-Key']).toBe('grl_key');
    expect(client.guardrailsConfig!.gatewayUrl).toBe('https://gw.example.com');
  });

  it('init with provider appends path to base_url', () => {
    const client = init({
      provider: 'openai',
      gatewayUrl: 'https://gw.example.com',
      apiKey: 'grl_key',
    });
    expect(client.guardrailsConfig!.baseUrl).toMatch(/\/openai$/);
  });

  it('init with policy_id sets header', () => {
    const client = init({
      provider: 'openai',
      gatewayUrl: 'https://gw.example.com',
      apiKey: 'grl_key',
      policyId: 'pol-1',
    });
    expect(client.guardrailsConfig!.headers['X-Guardrails-Policy-Id']).toBe('pol-1');
  });

  it('partial guardrails params throws', () => {
    expect(() => init({ gatewayUrl: 'https://gw.example.com' })).toThrow(/gateway_url and api_key are both required/);
  });

  it('unsupported provider throws', () => {
    expect(() => init({ provider: 'cohere' as never })).toThrow(/Unsupported provider/);
  });

  it('reads guardrails config from SWITCH_TRUST_* env vars', () => {
    process.env.SWITCH_TRUST_GATEWAY_URL = 'https://gw.env.com';
    process.env.SWITCH_TRUST_API_KEY = 'env-api-key';

    const client = init();

    expect(client.guardrailsConfig).not.toBeNull();
    expect(client.guardrailsConfig!.gatewayUrl).toBe('https://gw.env.com');
    expect(client.guardrailsConfig!.headers['X-FlintAI-API-Key']).toBe('env-api-key');
  });

  it('reads guardrails config from legacy FLINTAI_* fallback env vars', () => {
    process.env.FLINTAI_GATEWAY_URL = 'https://gw.env.com';
    process.env.FLINTAI_API_KEY = 'env-api-key';

    const client = init();

    expect(client.guardrailsConfig).not.toBeNull();
    expect(client.guardrailsConfig!.gatewayUrl).toBe('https://gw.env.com');
    expect(client.guardrailsConfig!.headers['X-FlintAI-API-Key']).toBe('env-api-key');
  });

  it('SWITCH_TRUST_* takes precedence over legacy FLINTAI_*', () => {
    process.env.FLINTAI_GATEWAY_URL = 'https://legacy.env.com';
    process.env.FLINTAI_API_KEY = 'legacy-key';
    process.env.SWITCH_TRUST_GATEWAY_URL = 'https://gw.env.com';
    process.env.SWITCH_TRUST_API_KEY = 'env-api-key';

    const client = init();

    expect(client.guardrailsConfig!.gatewayUrl).toBe('https://gw.env.com');
    expect(client.guardrailsConfig!.headers['X-FlintAI-API-Key']).toBe('env-api-key');
  });

  it('explicit params override env vars', () => {
    process.env.FLINTAI_GATEWAY_URL = 'https://gw.env.com';
    process.env.FLINTAI_API_KEY = 'env-api-key';

    const client = init({
      gatewayUrl: 'https://explicit.com',
      apiKey: 'explicit-key',
    });

    expect(client.guardrailsConfig!.gatewayUrl).toBe('https://explicit.com');
    expect(client.guardrailsConfig!.headers['X-FlintAI-API-Key']).toBe('explicit-key');
  });

  it('no env + no params → throws SwitchTrustGuardrailsError by default', () => {
    expect(() => init()).toThrow(SwitchTrustGuardrailsError);
  });

  it('no env + no params + requireGuardrails: false → guardrailsConfig is null', () => {
    const client = init({ requireGuardrails: false });
    expect(client.guardrailsConfig).toBeNull();
  });

  it('partial env vars throws', () => {
    process.env.FLINTAI_GATEWAY_URL = 'https://gw.env.com';

    expect(() => init()).toThrow(/gateway_url and api_key are both required/);
  });

  it('reads policy_id from FLINTAI_POLICY_ID', () => {
    process.env.FLINTAI_GATEWAY_URL = 'https://gw.env.com';
    process.env.FLINTAI_API_KEY = 'env-api-key';
    process.env.FLINTAI_POLICY_ID = 'env-pol-1';

    const client = init();

    expect(client.guardrailsConfig!.headers['X-Guardrails-Policy-Id']).toBe('env-pol-1');
  });

  it('explicit agent_id and agent_name used as-is', () => {
    const client = init({
      gatewayUrl: 'https://gw.example.com',
      apiKey: 'grl_key',
      agentId: 'search_agent_id',
      agentName: 'search_agent',
    });

    expect(client.guardrailsConfig!.agentId).toBe('search_agent_id');
    expect(client.guardrailsConfig!.agentName).toBe('search_agent');
  });

  it('requireGuardrails defaults to true', () => {
    const client = init({
      gatewayUrl: 'https://gw.example.com',
      apiKey: 'grl_key',
    });
    expect(client.requireGuardrails).toBe(true);
  });

  it('requireGuardrails: false is stored on client', () => {
    const client = init({ requireGuardrails: false });
    expect(client.requireGuardrails).toBe(false);
  });

  it('requireGuardrails: false emits an audit warning (unguarded)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    init({ requireGuardrails: false });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SECURITY CONTROL DISABLED'));
    warn.mockRestore();
  });

  it('requireGuardrails: true does not emit the opt-out warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    init({ gatewayUrl: 'https://gw.example.com', apiKey: 'grl_key' });
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('SECURITY CONTROL DISABLED'));
    warn.mockRestore();
  });

  it('opt-out warning is emitted at most once per process', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    init({ requireGuardrails: false });
    init({ requireGuardrails: false });
    init({ requireGuardrails: false });
    const optOutCalls = warn.mock.calls.filter((c) => String(c[0]).includes('SECURITY CONTROL DISABLED'));
    expect(optOutCalls).toHaveLength(1);
    warn.mockRestore();
  });
});

describe('dangerouslyDisableGuardrails (explicit opt-out name)', () => {
  it('is equivalent to requireGuardrails: false', () => {
    const client = init({ dangerouslyDisableGuardrails: true });
    expect(client.requireGuardrails).toBe(false);
    expect(client.guardrailsConfig).toBeNull();
  });

  it('emits the audit warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    init({ dangerouslyDisableGuardrails: true });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SECURITY CONTROL DISABLED'));
    warn.mockRestore();
  });

  it('throws when combined with requireGuardrails: true', () => {
    expect(() => init({ dangerouslyDisableGuardrails: true, requireGuardrails: true })).toThrow(/Conflicting options/);
  });

  it('does not disable guardrails when false', () => {
    const client = init({ gatewayUrl: 'https://gw.example.com', apiKey: 'grl_key', dangerouslyDisableGuardrails: false });
    expect(client.requireGuardrails).toBe(true);
  });
});

describe('status()', () => {
  it('returns null before init', () => {
    shutdown();
    expect(status()).toBeNull();
  });

  it('reports active + enforcing when guardrails are configured', () => {
    init({ gatewayUrl: 'https://gw.example.com', apiKey: 'grl_key', agentId: 'a1', agentName: 'agent-one' });
    expect(status()).toEqual({
      active: true,
      requireGuardrails: true,
      provider: null,
      agentId: 'a1',
      agentName: 'agent-one',
    });
  });

  it('reports inactive when opted out with no config', () => {
    init({ provider: 'openai', dangerouslyDisableGuardrails: true });
    expect(status()).toMatchObject({ active: false, requireGuardrails: false, provider: 'openai' });
  });
});
