import { describe, it, expect, vi } from 'vitest';
import { validateAndBuildConfig, resolveOnInit } from '../src/plugins/provider-base.js';
import { SwitchTrustClient } from '../src/core.js';
import { GuardrailsConfig, SwitchTrustGuardrailsError } from '../src/guardrails.js';

const GW = 'https://gw.example.com';
const AK = 'grl_sk_test';

describe('validateAndBuildConfig', () => {
  it.each([
    ['all params', { gatewayUrl: GW, apiKey: AK, provider: 'google' as const }, true],
    ['no params', { provider: 'google' as const }, false],
  ] as const)('%s → configFromConstructor=%s', (_label, opts, expectConfig) => {
    const [config, fromCtor] = validateAndBuildConfig(opts);
    expect(fromCtor).toBe(expectConfig);
    if (expectConfig) {
      expect(config).not.toBeNull();
      expect(config!.baseUrl).toContain('/gemini');
    } else {
      expect(config).toBeNull();
    }
  });

  it('throws on partial params', () => {
    expect(() => validateAndBuildConfig({ gatewayUrl: GW, provider: 'google' })).toThrow(/gateway_url and api_key are both required/);
  });

  it('resolves agentId and agentName', () => {
    const [withId] = validateAndBuildConfig({ gatewayUrl: GW, apiKey: AK, provider: 'google', agentId: 'custom', agentName: 'bot' });
    expect(withId!.agentId).toBe('custom');
    expect(withId!.agentName).toBe('bot');
  });

  it('includes policyId in headers', () => {
    const [config] = validateAndBuildConfig({ gatewayUrl: GW, apiKey: AK, provider: 'google', policyId: 'pol-1' });
    expect(config!.headers['X-Guardrails-Policy-Id']).toBe('pol-1');
  });
});

describe('resolveOnInit', () => {
  function makeConfig(): GuardrailsConfig {
    return new GuardrailsConfig({ baseUrl: GW + '/gemini', headers: {}, provider: 'google', gatewayUrl: GW });
  }

  it.each([
    ['constructor config attaches to client', true, true, true, true],
    ['constructor true + null config falls through to client', true, false, false, false],
    ['no-constructor uses client config', false, false, true, true],
    ['no config anywhere warns when requireGuardrails is false', false, false, false, false],
  ] as const)('%s', (_label, fromCtor, hasCtorConfig, hasClientConfig, requireGuardrails) => {
    const infoSpy = vi.spyOn(console, 'info');
    const warnSpy = vi.spyOn(console, 'warn');
    const client = new SwitchTrustClient('google');
    const ctorConfig = hasCtorConfig ? makeConfig() : null;
    if (hasClientConfig && !hasCtorConfig) client.guardrailsConfig = makeConfig();

    const result = resolveOnInit(client, ctorConfig, fromCtor, requireGuardrails);

    if (fromCtor && hasCtorConfig) {
      expect(result).toBe(ctorConfig);
      expect(client.guardrailsConfig).toBe(ctorConfig);
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('will route through'));
    } else if (hasClientConfig) {
      expect(result).not.toBeNull();
      expect(infoSpy).toHaveBeenCalled();
    } else {
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No guardrails config found'));
    }
  });

  it('throws SwitchTrustGuardrailsError when requireGuardrails is true and no config found', () => {
    const client = new SwitchTrustClient('google');
    expect(() => resolveOnInit(client, null, false, true)).toThrow(SwitchTrustGuardrailsError);
  });
});
