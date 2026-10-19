import * as switchTrust from '../src/index.js';
import { ADKGuardrailsPlugin } from '../src/plugins/adk.js';
import { SwitchTrustGuardrailsError } from '../src/guardrails.js';
import { vi } from 'vitest';

vi.mock('../src/module-loader.js', () => ({
  loadModule: (name: string) => {
    if (name === '@google/adk')
      return {
        models: {
          LlmResponse: class LlmResponse {
            constructor(opts: unknown) {
              Object.assign(this, opts as object);
            }
          },
        },
      };
    if (name === '@google/genai')
      return {
        types: {
          Content: class Content {
            constructor(opts: unknown) {
              Object.assign(this, opts as object);
            }
          },
          Part: class Part {
            constructor(opts: unknown) {
              Object.assign(this, opts as object);
            }
          },
        },
      };
    throw new Error(`Module not available in test: ${name}`);
  },
}));

// ---------------------------------------------------------------------------
// Plugin initialization
// ---------------------------------------------------------------------------

describe('plugin initialization', () => {
  it('creates content_config with guardrails headers (via init + register)', () => {
    switchTrust.init({
      provider: 'google',
      gatewayUrl: 'https://api.switchagents.ai',
      apiKey: 'grl_sk_test',
    });
    const plugin = new ADKGuardrailsPlugin();
    switchTrust.registerPlugin(plugin);

    const cfg = plugin.contentConfig as any;
    expect(cfg).not.toBeNull();
    expect(cfg.httpOptions.baseUrl).toBe('https://api.switchagents.ai/gemini/');
    expect(cfg.httpOptions.headers['X-FlintAI-API-Key']).toBe('grl_sk_test');
  });

  it('simplified flow: constructor params build contentConfig without init', () => {
    const plugin = new ADKGuardrailsPlugin({
      gatewayUrl: 'https://api.switchagents.ai',
      apiKey: 'grl_sk_test',
    });

    const cfg = plugin.contentConfig as any;
    expect(cfg).not.toBeNull();
    expect(cfg.httpOptions.baseUrl).toBe('https://api.switchagents.ai/gemini/');
    expect(cfg.httpOptions.headers['X-FlintAI-API-Key']).toBe('grl_sk_test');
  });

  it('merges user contentConfig into a clone without mutating the caller object', () => {
    const userConfig: any = { temperature: 0.7, top_p: 0.9 };
    const plugin = new ADKGuardrailsPlugin({
      gatewayUrl: 'https://api.switchagents.ai',
      apiKey: 'grl_sk_test',
      contentConfig: userConfig,
    });

    const cfg = plugin.contentConfig as any;
    // The clone carries the user settings plus guardrails http_options...
    expect(cfg).not.toBe(userConfig);
    expect(cfg.temperature).toBe(0.7);
    expect(cfg.httpOptions.baseUrl).toBe('https://api.switchagents.ai/gemini/');
    expect(cfg.httpOptions.headers['X-FlintAI-API-Key']).toBe('grl_sk_test');
    // ...but the caller's object is left untouched.
    expect(userConfig.httpOptions).toBeUndefined();
  });

  it('reusing one contentConfig across plugins does not cross-contaminate', () => {
    const shared: any = { temperature: 0.5 };
    const a = new ADKGuardrailsPlugin({
      gatewayUrl: 'https://gw.example.com',
      apiKey: 'grl_a',
      contentConfig: shared,
    });
    const b = new ADKGuardrailsPlugin({
      gatewayUrl: 'https://gw.env.com',
      apiKey: 'grl_b',
      contentConfig: shared,
    });

    const cfgA = a.contentConfig as any;
    const cfgB = b.contentConfig as any;
    expect(cfgA).not.toBe(cfgB);
    expect(cfgA.httpOptions.baseUrl).toBe('https://gw.example.com/gemini/');
    expect(cfgB.httpOptions.baseUrl).toBe('https://gw.env.com/gemini/');
    expect(cfgA.httpOptions.headers['X-FlintAI-API-Key']).toBe('grl_a');
    expect(cfgB.httpOptions.headers['X-FlintAI-API-Key']).toBe('grl_b');
    expect(shared.httpOptions).toBeUndefined();
  });

  it('simplified with policy_id sets X-Guardrails-Policy-Id header', () => {
    const plugin = new ADKGuardrailsPlugin({
      gatewayUrl: 'https://api.switchagents.ai',
      apiKey: 'grl_sk_test',
      policyId: 'pol-1',
    });

    const cfg = plugin.contentConfig as any;
    expect(cfg.httpOptions.headers['X-Guardrails-Policy-Id']).toBe('pol-1');
  });

  it('explicit agent_id and agent_name sets X-Agent-Id and X-Agent-Name headers as-is', () => {
    const plugin = new ADKGuardrailsPlugin({
      gatewayUrl: 'https://api.switchagents.ai',
      apiKey: 'grl_sk_test',
      agentId: 'custom_id',
      agentName: 'custom_name',
    });

    const cfg = plugin.contentConfig as any;
    expect(cfg.httpOptions.headers['X-Agent-Id']).toBe('custom_id');
    expect(cfg.httpOptions.headers['X-Agent-Name']).toBe('custom_name');
  });
});

// ---------------------------------------------------------------------------
// Plugin lifecycle
// ---------------------------------------------------------------------------

describe('plugin lifecycle', () => {
  it('on_init with constructor config attaches config and logs routing', () => {
    const infoSpy = vi.spyOn(console, 'info');
    const plugin = new ADKGuardrailsPlugin({
      gatewayUrl: 'https://api.switchagents.ai',
      apiKey: 'grl_sk_test',
    });
    const client = switchTrust.init({ provider: 'google', requireGuardrails: false });
    switchTrust.registerPlugin(plugin);

    expect(client.guardrailsConfig).toBe((plugin as any)._config);
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('will route through'));
  });

  it('partial params raises when only gatewayUrl provided', () => {
    expect(() => new ADKGuardrailsPlugin({ gatewayUrl: 'https://gw.example.com' })).toThrow(/gateway_url and api_key are both required/);
  });

  it('no guardrails config throws SwitchTrustGuardrailsError when requireGuardrails is true', () => {
    switchTrust.init({ provider: 'google', requireGuardrails: false });
    const plugin = new ADKGuardrailsPlugin({ requireGuardrails: true });
    expect(() => switchTrust.registerPlugin(plugin)).toThrow(SwitchTrustGuardrailsError);
  });

  it('no guardrails config warns when requireGuardrails is false', () => {
    const warnSpy = vi.spyOn(console, 'warn');
    switchTrust.init({ provider: 'google', requireGuardrails: false });
    const plugin = new ADKGuardrailsPlugin({ requireGuardrails: false });
    switchTrust.registerPlugin(plugin);

    expect(plugin.contentConfig).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No guardrails config found'));
  });

  it('onInit rebuilds contentConfig from client guardrails when constructor had no config', () => {
    switchTrust.init({
      provider: 'google',
      gatewayUrl: 'https://api.switchagents.ai',
      apiKey: 'grl_sk_test',
    });
    const plugin = new ADKGuardrailsPlugin();
    expect(plugin.contentConfig).toBeNull();

    switchTrust.registerPlugin(plugin);

    const cfg = plugin.contentConfig as any;
    expect(cfg).not.toBeNull();
    expect(cfg.httpOptions.baseUrl).toContain('/gemini/');
  });
});

// ---------------------------------------------------------------------------
// Provider routing
// ---------------------------------------------------------------------------

describe('provider routing', () => {
  it('uses openai path when init with openai provider', () => {
    switchTrust.init({
      provider: 'openai',
      gatewayUrl: 'https://gw.example.com',
      apiKey: 'grl_key',
    });
    const plugin = new ADKGuardrailsPlugin();
    switchTrust.registerPlugin(plugin);

    const cfg = plugin.contentConfig as any;
    expect(cfg.httpOptions.baseUrl).toContain('/openai/');
  });
});

// ---------------------------------------------------------------------------
// onModelError
// ---------------------------------------------------------------------------

describe('onModelError', () => {
  async function importPlugin() {
    vi.resetModules();
    const mod = await import('../src/plugins/adk.js');
    return mod.ADKGuardrailsPlugin;
  }

  it('re-throws non-blocked errors', async () => {
    const Plugin = await importPlugin();
    expect(() => Plugin.onModelError({}, {}, new Error('connection timeout'))).toThrow('connection timeout');
  });

  it('detects block via structured code in error.error (google-genai APIError)', async () => {
    const Plugin = await importPlugin();
    const err = new Error('400 Bad Request') as Error & Record<string, unknown>;
    err.error = {
      error: 'Blocked by SandboxAQ Guardrail Service',
      code: 'GUARDRAIL_BLOCKED',
      policy_id: 'pol-123',
      policy_name: 'Test Policy',
      findings: [{ category: 'pii', severity: 'High', message: 'Sensitive data' }],
    };

    const warnSpy = vi.spyOn(console, 'warn');
    const result = Plugin.onModelError({}, {}, err) as any;
    expect(result.error_code).toBe('GUARDRAIL_BLOCKED');
    expect(result.turn_complete).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    expect(result.custom_metadata).toBeDefined();
    expect(result.custom_metadata.policy_id).toBe('pol-123');
    expect(result.custom_metadata.policy_name).toBe('Test Policy');
    expect(result.custom_metadata.findings).toHaveLength(1);
  });

  it('detects block via structured code in error.body (non-google-genai fallback)', async () => {
    const Plugin = await importPlugin();
    const err = new Error('400 Bad Request') as Error & Record<string, unknown>;
    err.body = { error: 'Blocked by SandboxAQ Guardrail Service', code: 'GUARDRAIL_BLOCKED', policy_id: 'pol-456', policy_name: 'Test Policy', findings: [] };

    const result = Plugin.onModelError({}, {}, err) as any;
    expect(result.error_code).toBe('GUARDRAIL_BLOCKED');
    expect(result.custom_metadata.policy_id).toBe('pol-456');
  });

  it('error.error takes priority over error.body', async () => {
    const Plugin = await importPlugin();
    const err = new Error('400 Bad Request') as Error & Record<string, unknown>;
    err.error = { code: 'GUARDRAIL_BLOCKED', policy_id: 'from-error', policy_name: 'Test Policy', findings: [] };
    err.body = { code: 'GUARDRAIL_BLOCKED', policy_id: 'from-body', policy_name: 'Test Policy', findings: [] };

    const result = Plugin.onModelError({}, {}, err) as any;
    expect(result.custom_metadata.policy_id).toBe('from-error');
  });

  it('does not detect block from GUARDRAIL_BLOCKED in stringified error (no structured code)', async () => {
    const Plugin = await importPlugin();
    // An unrelated provider error whose text merely contains the marker must not
    // be misclassified as a block — detection relies solely on the structured code.
    const err = new Error('{"error": "Blocked by SandboxAQ Guardrail Service", "code": "GUARDRAIL_BLOCKED"}');

    expect(() => Plugin.onModelError({}, {}, err)).toThrow(/GUARDRAIL_BLOCKED/);
  });

  it('does not match 403 auth errors without structured code', async () => {
    const Plugin = await importPlugin();
    const err = new Error('invalid API key') as Error & { status_code?: number };
    err.status_code = 403;

    expect(() => Plugin.onModelError({}, {}, err)).toThrow('invalid API key');
  });

  it('does not match generic "blocked" keyword without structured code', async () => {
    const Plugin = await importPlugin();
    const err = new Error('connection blocked by firewall');

    expect(() => Plugin.onModelError({}, {}, err)).toThrow('connection blocked by firewall');
  });

  it('accepts the full gateway payload with populated findings', async () => {
    const Plugin = await importPlugin();
    const err = new Error('400 Bad Request') as Error & Record<string, unknown>;
    err.error = {
      code: 'GUARDRAIL_BLOCKED',
      error: 'Blocked by SandboxAQ Guardrail Service [Block-PII-Secrets-Jailbreak]',
      findings: [{ category: 'jailbreak', severity: 'medium', message: 'Jailbreak attempt detected' }],
      policy_id: '4018f06e-b53b-4ce7-a6de-f69e5f9f5eb4',
      policy_name: 'Block-PII-Secrets-Jailbreak',
    };

    const result = Plugin.onModelError({}, {}, err) as any;
    expect(result.error_code).toBe('GUARDRAIL_BLOCKED');
    expect(result.custom_metadata.policy_name).toBe('Block-PII-Secrets-Jailbreak');
    expect(result.custom_metadata.findings).toHaveLength(1);
  });

  it('tolerates unknown keys in the payload and in findings (forward-compat)', async () => {
    const Plugin = await importPlugin();
    const err = new Error('400 Bad Request') as Error & Record<string, unknown>;
    err.error = {
      code: 'GUARDRAIL_BLOCKED',
      policy_id: 'pol-1',
      policy_name: 'Test Policy',
      findings: [{ category: 'pii', severity: 'high', message: 'x', confidence: 0.9 }],
      request_id: 'req-abc',
    };

    const result = Plugin.onModelError({}, {}, err) as any;
    expect(result.error_code).toBe('GUARDRAIL_BLOCKED');
    expect(result.custom_metadata.policy_id).toBe('pol-1');
  });

  it('throws when a block payload is missing policy_id', async () => {
    const Plugin = await importPlugin();
    const err = new Error('400 Bad Request') as Error & Record<string, unknown>;
    err.error = { code: 'GUARDRAIL_BLOCKED', policy_name: 'Test Policy', findings: [] };

    expect(() => Plugin.onModelError({}, {}, err)).toThrow(/malformed: policy_id/);
  });

  it('throws when a block payload has non-array findings', async () => {
    const Plugin = await importPlugin();
    const err = new Error('400 Bad Request') as Error & Record<string, unknown>;
    err.error = { code: 'GUARDRAIL_BLOCKED', policy_id: 'pol-1', policy_name: 'Test Policy', findings: 'nope' };

    expect(() => Plugin.onModelError({}, {}, err)).toThrow(/findings must be an array/);
  });

  it('throws when a finding item is malformed', async () => {
    const Plugin = await importPlugin();
    const err = new Error('400 Bad Request') as Error & Record<string, unknown>;
    err.error = {
      code: 'GUARDRAIL_BLOCKED',
      policy_id: 'pol-1',
      policy_name: 'Test Policy',
      findings: [{ category: 'pii', severity: 'high' }],
    };

    expect(() => Plugin.onModelError({}, {}, err)).toThrow(/finding.message must be a string/);
  });
});

// ---------------------------------------------------------------------------
// beforeModelCallback
// ---------------------------------------------------------------------------

describe('beforeModelCallback', () => {
  it('injects agent_name and session_id', () => {
    const plugin = new ADKGuardrailsPlugin({
      gatewayUrl: 'https://api.switchagents.ai',
      apiKey: 'grl_sk_test',
    });

    const callbackContext = { agent_name: 'search_agent', session: { id: 'sess-abc-123' } };
    const llmRequest = {
      config: {
        httpOptions: {
          baseUrl: 'https://api.switchagents.ai/gemini/',
          headers: { 'X-FlintAI-API-Key': 'grl_sk_test' } as Record<string, string>,
        },
      },
    };

    const result = plugin.beforeModelCallback({ context: callbackContext, request: llmRequest });

    expect(result).toBeNull();
    expect(llmRequest.config.httpOptions.headers['X-Agent-Name']).toBe('search_agent');
    expect(llmRequest.config.httpOptions.headers['X-Agent-Session-Id']).toBe('sess-abc-123');
    expect(llmRequest.config.httpOptions.headers['X-FlintAI-API-Key']).toBe('grl_sk_test');
  });

  it('no agent_name does not set X-Agent-Name but does set X-Agent-Session-Id', () => {
    const plugin = new ADKGuardrailsPlugin({
      gatewayUrl: 'https://api.switchagents.ai',
      apiKey: 'grl_sk_test',
    });

    const callbackContext: { session: { id: string } } = { session: { id: 'sess-abc-123' } };
    const llmRequest = {
      config: {
        httpOptions: {
          baseUrl: 'https://api.switchagents.ai/gemini/',
          headers: { 'X-FlintAI-API-Key': 'grl_sk_test' } as Record<string, string>,
        },
      },
    };

    const result = plugin.beforeModelCallback({ context: callbackContext, request: llmRequest });

    expect(result).toBeNull();
    expect('X-Agent-Name' in llmRequest.config.httpOptions.headers).toBe(false);
    expect(llmRequest.config.httpOptions.headers['X-Agent-Session-Id']).toBe('sess-abc-123');
  });

  it('static agent_name (constructor) takes precedence over callback agent_name', () => {
    // Static overrides come from the constructor (snapshotted), not the request.
    const plugin = new ADKGuardrailsPlugin({
      gatewayUrl: 'https://api.switchagents.ai',
      apiKey: 'grl_sk_test',
      agentName: 'static_override',
    });

    const callbackContext = { agent_name: 'search_agent', session: { id: 'sess-abc-123' } };
    const llmRequest = {
      config: {
        httpOptions: {
          baseUrl: 'https://api.switchagents.ai/gemini/',
          headers: { 'X-FlintAI-API-Key': 'grl_sk_test' } as Record<string, string>,
        },
      },
    };

    plugin.beforeModelCallback({ context: callbackContext, request: llmRequest });

    expect(llmRequest.config.httpOptions.headers['X-Agent-Name']).toBe('static_override');
  });

  it('no session does not set X-Agent-Session-Id but does set X-Agent-Name', () => {
    const plugin = new ADKGuardrailsPlugin({
      gatewayUrl: 'https://api.switchagents.ai',
      apiKey: 'grl_sk_test',
    });

    const callbackContext: { agent_name: string } = { agent_name: 'search_agent' };
    const llmRequest = {
      config: {
        httpOptions: {
          baseUrl: 'https://api.switchagents.ai/gemini/',
          headers: { 'X-FlintAI-API-Key': 'grl_sk_test' } as Record<string, string>,
        },
      },
    };

    const result = plugin.beforeModelCallback({ context: callbackContext, request: llmRequest });

    expect(result).toBeNull();
    expect(llmRequest.config.httpOptions.headers['X-Agent-Name']).toBe('search_agent');
    expect('X-Agent-Session-Id' in llmRequest.config.httpOptions.headers).toBe(false);
  });

  it('reads httpOptions (camelCase) when httpOptions is absent', () => {
    const plugin = new ADKGuardrailsPlugin({
      gatewayUrl: 'https://api.switchagents.ai',
      apiKey: 'grl_sk_test',
    });

    const callbackContext = { agent_name: 'search_agent', session: { id: 'sess-1' } };
    const llmRequest = {
      config: {
        httpOptions: {
          baseUrl: 'https://api.switchagents.ai/gemini/',
          headers: { 'X-FlintAI-API-Key': 'grl_sk_test' } as Record<string, string>,
        },
      },
    };

    plugin.beforeModelCallback({ context: callbackContext, request: llmRequest });

    expect(llmRequest.config.httpOptions.headers['X-Agent-Name']).toBe('search_agent');
    expect(llmRequest.config.httpOptions.headers['X-Agent-Session-Id']).toBe('sess-1');
  });

  it('config none throws SwitchTrustGuardrailsError when requireGuardrails is true', () => {
    const plugin = new ADKGuardrailsPlugin({
      gatewayUrl: 'https://api.switchagents.ai',
      apiKey: 'grl_sk_test',
    });

    const callbackContext = { agent_name: 'search_agent' };
    const llmRequest = { config: null };

    expect(() => plugin.beforeModelCallback({ context: callbackContext, request: llmRequest })).toThrow(SwitchTrustGuardrailsError);
  });

  it('config none returns null when requireGuardrails is false', () => {
    const plugin = new ADKGuardrailsPlugin({
      gatewayUrl: 'https://api.switchagents.ai',
      apiKey: 'grl_sk_test',
      requireGuardrails: false,
    });

    const callbackContext = { agent_name: 'search_agent' };
    const llmRequest = { config: null };

    const result = plugin.beforeModelCallback({ context: callbackContext, request: llmRequest });
    expect(result).toBeNull();
  });

  it('http_options none throws SwitchTrustGuardrailsError when requireGuardrails is true', () => {
    const plugin = new ADKGuardrailsPlugin({
      gatewayUrl: 'https://api.switchagents.ai',
      apiKey: 'grl_sk_test',
    });

    const callbackContext = { session: { id: 'sess-abc-123' } };
    const llmRequest = { config: { http_options: null } };

    expect(() => plugin.beforeModelCallback({ context: callbackContext, request: llmRequest })).toThrow(SwitchTrustGuardrailsError);
  });

  it('http_options none returns null when requireGuardrails is false', () => {
    const plugin = new ADKGuardrailsPlugin({
      gatewayUrl: 'https://api.switchagents.ai',
      apiKey: 'grl_sk_test',
      requireGuardrails: false,
    });

    const callbackContext = { session: { id: 'sess-abc-123' } };
    const llmRequest = { config: { http_options: null } };

    const result = plugin.beforeModelCallback({ context: callbackContext, request: llmRequest });
    expect(result).toBeNull();
  });

  it('headers none initializes headers and sets both X-Agent-Name and X-Agent-Session-Id', () => {
    const plugin = new ADKGuardrailsPlugin({
      gatewayUrl: 'https://api.switchagents.ai',
      apiKey: 'grl_sk_test',
      requireGuardrails: false,
    });

    const callbackContext = { agent_name: 'search_agent', session: { id: 'sess-abc-123' } };
    const httpOptions: Record<string, unknown> = { headers: null };
    const llmRequest = { config: { httpOptions: httpOptions } };

    const result = plugin.beforeModelCallback({ context: callbackContext, request: llmRequest });

    expect(result).toBeNull();
    const headers = (llmRequest.config.httpOptions as { headers: Record<string, string> }).headers;
    expect(headers['X-Agent-Name']).toBe('search_agent');
    expect(headers['X-Agent-Session-Id']).toBe('sess-abc-123');
  });

  it('sequential reuse: clears stale X-Agent-Session-Id when a later request has no session', () => {
    const plugin = new ADKGuardrailsPlugin({
      gatewayUrl: 'https://api.switchagents.ai',
      apiKey: 'grl_sk_test',
    });

    // One shared config object, reused across two callbacks (the ADK case where
    // the agent's generate_content_config is reused for every turn).
    const llmRequest = {
      config: {
        httpOptions: {
          baseUrl: 'https://api.switchagents.ai/gemini/',
          headers: { 'X-FlintAI-API-Key': 'grl_sk_test' } as Record<string, string>,
        },
      },
    };

    plugin.beforeModelCallback({ context: { session: { id: 'sess-1' } }, request: llmRequest });
    expect(llmRequest.config.httpOptions.headers['X-Agent-Session-Id']).toBe('sess-1');

    // Second turn has no session — the stale id must not carry over.
    plugin.beforeModelCallback({ context: {}, request: llmRequest });
    expect('X-Agent-Session-Id' in llmRequest.config.httpOptions.headers).toBe(false);
    expect(llmRequest.config.httpOptions.headers['X-FlintAI-API-Key']).toBe('grl_sk_test');
  });

  it('reads the session id from @google/adk context.sessionId', () => {
    const plugin = new ADKGuardrailsPlugin({ gatewayUrl: 'https://api.switchagents.ai', apiKey: 'grl_sk_test' });
    const llmRequest = {
      config: { httpOptions: { baseUrl: 'https://api.switchagents.ai/gemini/', headers: { 'X-FlintAI-API-Key': 'grl_sk_test' } as Record<string, string> } },
    };

    plugin.beforeModelCallback({ context: { sessionId: 'sess-ts', agentName: 'expense_tracker', invocationId: 'e-1' }, request: llmRequest });

    expect(llmRequest.config.httpOptions.headers['X-Agent-Session-Id']).toBe('sess-ts');
    expect(llmRequest.config.httpOptions.headers['X-Agent-Name']).toBe('expense_tracker');
  });

  it('injects X-Agent-Turn-Id from the invocation id', () => {
    const plugin = new ADKGuardrailsPlugin({ gatewayUrl: 'https://api.switchagents.ai', apiKey: 'grl_sk_test' });
    const llmRequest = {
      config: { httpOptions: { baseUrl: 'https://api.switchagents.ai/gemini/', headers: { 'X-FlintAI-API-Key': 'grl_sk_test' } as Record<string, string> } },
    };

    plugin.beforeModelCallback({ context: { session: { id: 'sess-1' }, invocationId: 'e-turn-1' }, request: llmRequest });

    expect(llmRequest.config.httpOptions.headers['X-Agent-Turn-Id']).toBe('e-turn-1');
    expect(llmRequest.config.httpOptions.headers['X-Agent-Session-Id']).toBe('sess-1');
  });

  it('omits X-Agent-Turn-Id when there is no string invocation id', () => {
    const plugin = new ADKGuardrailsPlugin({ gatewayUrl: 'https://api.switchagents.ai', apiKey: 'grl_sk_test' });
    for (const context of [{}, { invocationId: '' }, { invocationId: 42 }]) {
      const llmRequest = {
        config: {
          httpOptions: { baseUrl: 'https://api.switchagents.ai/gemini/', headers: { 'X-FlintAI-API-Key': 'grl_sk_test' } as Record<string, string> },
        },
      };
      plugin.beforeModelCallback({ context, request: llmRequest });
      expect('X-Agent-Turn-Id' in llmRequest.config.httpOptions.headers).toBe(false);
    }
  });

  it('sequential reuse: each turn sends its own X-Agent-Turn-Id, never a stale one', () => {
    const plugin = new ADKGuardrailsPlugin({ gatewayUrl: 'https://api.switchagents.ai', apiKey: 'grl_sk_test' });
    const llmRequest = {
      config: { httpOptions: { baseUrl: 'https://api.switchagents.ai/gemini/', headers: { 'X-FlintAI-API-Key': 'grl_sk_test' } as Record<string, string> } },
    };

    plugin.beforeModelCallback({ context: { invocationId: 'e-turn-1' }, request: llmRequest });
    expect(llmRequest.config.httpOptions.headers['X-Agent-Turn-Id']).toBe('e-turn-1');

    plugin.beforeModelCallback({ context: { invocationId: 'e-turn-2' }, request: llmRequest });
    expect(llmRequest.config.httpOptions.headers['X-Agent-Turn-Id']).toBe('e-turn-2');

    plugin.beforeModelCallback({ context: {}, request: llmRequest });
    expect('X-Agent-Turn-Id' in llmRequest.config.httpOptions.headers).toBe(false);
  });

  it('mixed-session reuse: a later session id overwrites an earlier one', () => {
    const plugin = new ADKGuardrailsPlugin({
      gatewayUrl: 'https://api.switchagents.ai',
      apiKey: 'grl_sk_test',
    });

    const llmRequest = {
      config: {
        httpOptions: {
          baseUrl: 'https://api.switchagents.ai/gemini/',
          headers: { 'X-FlintAI-API-Key': 'grl_sk_test' } as Record<string, string>,
        },
      },
    };

    plugin.beforeModelCallback({ context: { session: { id: 'sess-a' } }, request: llmRequest });
    expect(llmRequest.config.httpOptions.headers['X-Agent-Session-Id']).toBe('sess-a');

    plugin.beforeModelCallback({ context: { session: { id: 'sess-b' } }, request: llmRequest });
    expect(llmRequest.config.httpOptions.headers['X-Agent-Session-Id']).toBe('sess-b');
  });

  it('reused config across agents: X-Agent-Name is not carried over', () => {
    // One config threaded through two turns; turn 2 must not inherit turn 1's name.
    const plugin = new ADKGuardrailsPlugin({
      gatewayUrl: 'https://api.switchagents.ai',
      apiKey: 'grl_sk_test',
    });

    const llmRequest = {
      config: {
        httpOptions: {
          baseUrl: 'https://api.switchagents.ai/gemini/',
          headers: { 'X-FlintAI-API-Key': 'grl_sk_test' } as Record<string, string>,
        },
      },
    };

    plugin.beforeModelCallback({ context: { agent_name: 'root_agent' }, request: llmRequest });
    expect(llmRequest.config.httpOptions.headers['X-Agent-Name']).toBe('root_agent');

    plugin.beforeModelCallback({ context: { agent_name: 'search_agent' }, request: llmRequest });
    expect(llmRequest.config.httpOptions.headers['X-Agent-Name']).toBe('search_agent');
  });

  it('does not mutate the plugin content_config headers in place across requests', () => {
    const plugin = new ADKGuardrailsPlugin({
      gatewayUrl: 'https://api.switchagents.ai',
      apiKey: 'grl_sk_test',
    });

    const cfg = plugin.contentConfig as any;
    const baseHeaders = cfg.httpOptions.headers;
    const llmRequest = { config: { httpOptions: cfg.httpOptions } };

    plugin.beforeModelCallback({ context: { session: { id: 'sess-1' } }, request: llmRequest });

    // content_config untouched; session id lands on the per-request config.
    expect(cfg.httpOptions.headers).toBe(baseHeaders);
    expect(cfg.httpOptions.headers['X-Agent-Session-Id']).toBeUndefined();
    expect(llmRequest.config.httpOptions.headers['X-Agent-Session-Id']).toBe('sess-1');
  });

  it('shared content_config across interleaved turns: each request keeps its own session id', () => {
    // Root agent + sub-agents share one contentConfig; ADK shallow-copies it
    // per turn, so config.http_options is the same object across turns.
    const plugin = new ADKGuardrailsPlugin({
      gatewayUrl: 'https://api.switchagents.ai',
      apiKey: 'grl_sk_test',
    });

    const shared = plugin.contentConfig as any;
    const sharedHttpOptions = shared.httpOptions;

    const reqA = { config: { ...shared } };
    const reqB = { config: { ...shared } };
    expect(reqA.config.httpOptions).toBe(sharedHttpOptions);
    expect(reqB.config.httpOptions).toBe(sharedHttpOptions);

    plugin.beforeModelCallback({ context: { session: { id: 'sess-a' } }, request: reqA });
    plugin.beforeModelCallback({ context: { session: { id: 'sess-b' } }, request: reqB });

    expect(reqA.config.httpOptions.headers['X-Agent-Session-Id']).toBe('sess-a');
    expect(reqB.config.httpOptions.headers['X-Agent-Session-Id']).toBe('sess-b');
    expect(reqA.config.httpOptions).not.toBe(sharedHttpOptions);
    expect(reqB.config.httpOptions).not.toBe(sharedHttpOptions);
    expect(reqA.config.httpOptions).not.toBe(reqB.config.httpOptions);
    expect('X-Agent-Session-Id' in sharedHttpOptions.headers).toBe(false);
    expect(reqA.config.httpOptions.headers['X-FlintAI-API-Key']).toBe('grl_sk_test');
    expect(reqB.config.httpOptions.headers['X-FlintAI-API-Key']).toBe('grl_sk_test');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('AGENT_NAME env var takes priority over callback agent_name', () => {
    vi.stubEnv('AGENT_NAME', 'env-agent-id');

    const plugin = new ADKGuardrailsPlugin({
      gatewayUrl: 'https://api.switchagents.ai',
      apiKey: 'grl_sk_test',
    });

    const callbackContext = { agent_name: 'search_agent', session: { id: 'sess-1' } };
    const llmRequest = {
      config: {
        httpOptions: {
          baseUrl: 'https://api.switchagents.ai/gemini/',
          headers: { 'X-FlintAI-API-Key': 'grl_sk_test' } as Record<string, string>,
        },
      },
    };

    plugin.beforeModelCallback({ context: callbackContext, request: llmRequest });

    expect(llmRequest.config.httpOptions.headers['X-Agent-Name']).toBe('env-agent-id');
  });
});

// ---------------------------------------------------------------------------
// beforeModelCallback enforcement
//
// When requireGuardrails is true, a request that is not routed through the
// FlintAI gateway (wrong/absent base_url, missing/mismatched X-FlintAI-API-Key)
// must be rejected with SwitchTrustGuardrailsError rather than passed through.
// ---------------------------------------------------------------------------

describe('beforeModelCallback enforcement', () => {
  function requiredPlugin() {
    return new ADKGuardrailsPlugin({
      gatewayUrl: 'https://api.switchagents.ai',
      apiKey: 'grl_sk_test',
      requireGuardrails: true,
    });
  }

  it('rejects empty httpOptions (no baseUrl, no API key)', () => {
    const plugin = requiredPlugin();
    const llmRequest = { config: { httpOptions: { headers: {} as Record<string, string> } } };

    expect(() => plugin.beforeModelCallback({ context: {}, request: llmRequest })).toThrow(SwitchTrustGuardrailsError);
  });

  it('rejects httpOptions pointing at a direct provider endpoint', () => {
    const plugin = requiredPlugin();
    const llmRequest = {
      config: {
        httpOptions: {
          baseUrl: 'https://generativelanguage.googleapis.com/',
          headers: { 'x-goog-api-key': 'AIza-direct-provider-key' } as Record<string, string>,
        },
      },
    };

    expect(() => plugin.beforeModelCallback({ context: {}, request: llmRequest })).toThrow(/baseUrl/);
  });

  it('rejects a mismatched X-FlintAI-API-Key value', () => {
    const plugin = requiredPlugin();
    const llmRequest = {
      config: {
        httpOptions: {
          baseUrl: 'https://api.switchagents.ai/gemini/',
          headers: { 'X-FlintAI-API-Key': 'totally-wrong-key' } as Record<string, string>,
        },
      },
    };

    expect(() => plugin.beforeModelCallback({ context: {}, request: llmRequest })).toThrow(/X-FlintAI-API-Key/);
  });

  it('allows a correctly-routed request (gateway baseUrl + matching API key)', () => {
    const plugin = requiredPlugin();
    const llmRequest = {
      config: {
        httpOptions: {
          baseUrl: 'https://api.switchagents.ai/gemini/',
          headers: { 'X-FlintAI-API-Key': 'grl_sk_test' } as Record<string, string>,
        },
      },
    };

    expect(plugin.beforeModelCallback({ context: {}, request: llmRequest })).toBeNull();
  });

  it('rejects an agent whose Gemini model uses the Interactions API, even with a correctly-routed config', () => {
    const plugin = requiredPlugin();
    const context = { invocationContext: { agent: { canonicalModel: { useInteractionsApi: true } } } };
    const llmRequest = {
      config: {
        httpOptions: {
          baseUrl: 'https://api.switchagents.ai/gemini/',
          headers: { 'X-FlintAI-API-Key': 'grl_sk_test' } as Record<string, string>,
        },
      },
    };

    expect(() => plugin.beforeModelCallback({ context, request: llmRequest })).toThrow(/useInteractionsApi/);
  });

  it('sends the validated baseUrl even when the caller hid it from property copies', () => {
    const plugin = requiredPlugin();
    const httpOptions = { headers: { 'X-FlintAI-API-Key': 'grl_sk_test' } as Record<string, string> };
    Object.defineProperty(httpOptions, 'baseUrl', { value: 'https://api.switchagents.ai/gemini/', enumerable: false });
    const llmRequest = { config: { httpOptions } as { httpOptions: Record<string, unknown> } };

    expect(plugin.beforeModelCallback({ context: {}, request: llmRequest })).toBeNull();
    expect(Object.keys(llmRequest.config.httpOptions)).toContain('baseUrl');
    expect(llmRequest.config.httpOptions.baseUrl).toBe('https://api.switchagents.ai/gemini/');
  });

  it('allows a correctly-routed request when the model does not use the Interactions API', () => {
    const plugin = requiredPlugin();
    const context = { invocationContext: { agent: { canonicalModel: { useInteractionsApi: false } } } };
    const llmRequest = {
      config: {
        httpOptions: {
          baseUrl: 'https://api.switchagents.ai/gemini/',
          headers: { 'X-FlintAI-API-Key': 'grl_sk_test' } as Record<string, string>,
        },
      },
    };

    expect(plugin.beforeModelCallback({ context, request: llmRequest })).toBeNull();
  });

  it('accepts baseUrl with or without a trailing slash', () => {
    const plugin = requiredPlugin();
    const llmRequest = {
      config: {
        httpOptions: {
          baseUrl: 'https://api.switchagents.ai/gemini',
          headers: { 'X-FlintAI-API-Key': 'grl_sk_test' } as Record<string, string>,
        },
      },
    };

    expect(plugin.beforeModelCallback({ context: {}, request: llmRequest })).toBeNull();
  });

  it('rejects empty headers when baseUrl is valid (missing API key)', () => {
    const plugin = requiredPlugin();
    const llmRequest = {
      config: {
        httpOptions: {
          baseUrl: 'https://api.switchagents.ai/gemini/',
          headers: {} as Record<string, string>,
        },
      },
    };

    expect(() => plugin.beforeModelCallback({ context: {}, request: llmRequest })).toThrow(/X-FlintAI-API-Key/);
  });

  it('enforces baseUrl validation on camelCase httpOptions (wrong gateway)', () => {
    const plugin = requiredPlugin();
    const llmRequest = {
      config: {
        httpOptions: {
          baseUrl: 'https://evil.example.com/gemini/',
          headers: { 'X-FlintAI-API-Key': 'grl_sk_test' } as Record<string, string>,
        },
      },
    };

    expect(() => plugin.beforeModelCallback({ context: {}, request: llmRequest })).toThrow(/baseUrl/);
  });

  it('enforces API key validation on camelCase httpOptions (missing key)', () => {
    const plugin = requiredPlugin();
    const llmRequest = {
      config: {
        httpOptions: {
          baseUrl: 'https://api.switchagents.ai/gemini/',
          headers: {} as Record<string, string>,
        },
      },
    };

    expect(() => plugin.beforeModelCallback({ context: {}, request: llmRequest })).toThrow(/X-FlintAI-API-Key/);
  });

  it('rejects a config that sets both http_options and httpOptions (dual-key bypass)', () => {
    const plugin = requiredPlugin();
    const llmRequest = {
      config: {
        http_options: {
          base_url: 'https://api.switchagents.ai/gemini/',
          headers: { 'X-FlintAI-API-Key': 'grl_sk_test' } as Record<string, string>,
        },
        httpOptions: {
          baseUrl: 'https://evil.example.com/gemini/',
          headers: {} as Record<string, string>,
        },
      },
    };

    expect(() => plugin.beforeModelCallback({ context: {}, request: llmRequest })).toThrow(/http_options, which @google\/genai ignores/);
  });

  it('rejects snake_case http_options even when it names the gateway and key', () => {
    const plugin = requiredPlugin();
    const llmRequest = {
      config: {
        http_options: {
          base_url: 'https://api.switchagents.ai/gemini/',
          headers: { 'X-FlintAI-API-Key': 'grl_sk_test' } as Record<string, string>,
        },
      },
    };

    expect(() => plugin.beforeModelCallback({ context: {}, request: llmRequest })).toThrow(/http_options, which @google\/genai ignores/);
  });

  it('rejects httpOptions that names the gateway as base_url instead of baseUrl', () => {
    const plugin = requiredPlugin();
    const llmRequest = {
      config: {
        httpOptions: {
          base_url: 'https://api.switchagents.ai/gemini/',
          headers: { 'X-FlintAI-API-Key': 'grl_sk_test' } as Record<string, string>,
        },
      },
    };

    expect(() => plugin.beforeModelCallback({ context: {}, request: llmRequest })).toThrow(/baseUrl/);
  });

  it('rejects a request built from a mutated copy of contentConfig (baseUrl tampered)', () => {
    const plugin = requiredPlugin();
    const trusted = plugin.contentConfig as { httpOptions: { baseUrl: string; headers: Record<string, string> } };

    // Caller reuses the plugin's config but points it at a different gateway after construction.
    const llmRequest = {
      config: {
        httpOptions: {
          baseUrl: 'https://evil.example.com/gemini/',
          headers: { ...trusted.httpOptions.headers },
        },
      },
    };

    expect(() => plugin.beforeModelCallback({ context: {}, request: llmRequest })).toThrow(/baseUrl/);
  });

  it('rejects a request built from a mutated copy of contentConfig (API key stripped)', () => {
    const plugin = requiredPlugin();
    const trusted = plugin.contentConfig as { httpOptions: { baseUrl: string; headers: Record<string, string> } };

    const headers = { ...trusted.httpOptions.headers };
    delete headers['X-FlintAI-API-Key'];
    const llmRequest = { config: { httpOptions: { baseUrl: trusted.httpOptions.baseUrl, headers } } };

    expect(() => plugin.beforeModelCallback({ context: {}, request: llmRequest })).toThrow(/X-FlintAI-API-Key/);
  });
});

// ---------------------------------------------------------------------------
// requireGuardrails: false opt-out — enforcement is skipped,
// so otherwise-rejected requests pass through.
// ---------------------------------------------------------------------------

describe('requireGuardrails: false opt-out', () => {
  function optedOutPlugin() {
    return new ADKGuardrailsPlugin({
      gatewayUrl: 'https://api.switchagents.ai',
      apiKey: 'grl_sk_test',
      requireGuardrails: false,
    });
  }

  it('allows an Interactions API model when opted out', () => {
    const plugin = optedOutPlugin();
    const context = { invocationContext: { agent: { canonicalModel: { useInteractionsApi: true } } } };
    const llmRequest = { config: { httpOptions: { baseUrl: 'https://api.switchagents.ai/gemini/', headers: {} as Record<string, string> } } };

    expect(plugin.beforeModelCallback({ context, request: llmRequest })).toBeNull();
  });

  it('allows a direct provider base_url when opted out (no base_url enforcement)', () => {
    const plugin = optedOutPlugin();
    const llmRequest = {
      config: {
        http_options: {
          base_url: 'https://generativelanguage.googleapis.com/',
          headers: { 'x-goog-api-key': 'AIza-direct-provider-key' } as Record<string, string>,
        },
      },
    };

    expect(plugin.beforeModelCallback({ context: {}, request: llmRequest })).toBeNull();
  });

  it('allows empty headers / missing API key when opted out (no key enforcement)', () => {
    const plugin = optedOutPlugin();
    const llmRequest = {
      config: {
        http_options: {
          base_url: 'https://api.switchagents.ai/gemini/',
          headers: {} as Record<string, string>,
        },
      },
    };

    expect(plugin.beforeModelCallback({ context: {}, request: llmRequest })).toBeNull();
  });

  it('allows a mismatched API key when opted out', () => {
    const plugin = optedOutPlugin();
    const llmRequest = {
      config: {
        http_options: {
          base_url: 'https://api.switchagents.ai/gemini/',
          headers: { 'X-FlintAI-API-Key': 'totally-wrong-key' } as Record<string, string>,
        },
      },
    };

    expect(plugin.beforeModelCallback({ context: {}, request: llmRequest })).toBeNull();
  });

  it('emits the audit warning on onInit when opted out (explicit)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Guarded init (no warning) so the warning we assert comes from the plugin path.
    switchTrust.init({ provider: 'google', gatewayUrl: 'https://api.switchagents.ai', apiKey: 'grl_sk_test' });
    const plugin = new ADKGuardrailsPlugin({ dangerouslyDisableGuardrails: true });
    switchTrust.registerPlugin(plugin);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SECURITY CONTROL DISABLED'));
    warn.mockRestore();
  });

  it('emits the audit warning when inheriting an opted-out client', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    switchTrust.init({ provider: 'google', gatewayUrl: 'https://api.switchagents.ai', apiKey: 'grl_sk_test', requireGuardrails: false });
    const plugin = new ADKGuardrailsPlugin();
    switchTrust.registerPlugin(plugin);
    // Once-per-process: init already warned, so total opt-out warnings stay at one.
    const optOutCalls = warn.mock.calls.filter((c) => String(c[0]).includes('SECURITY CONTROL DISABLED'));
    expect(optOutCalls).toHaveLength(1);
    warn.mockRestore();
  });

  it('throws on conflicting opt-out options', () => {
    expect(() => new ADKGuardrailsPlugin({ dangerouslyDisableGuardrails: true, requireGuardrails: true })).toThrow(/Conflicting options/);
  });

  it('dangerouslyDisableGuardrails resolves to requireGuardrails=false', () => {
    switchTrust.init({ provider: 'google', gatewayUrl: 'https://api.switchagents.ai', apiKey: 'grl_sk_test' });
    const plugin = new ADKGuardrailsPlugin({ dangerouslyDisableGuardrails: true });
    switchTrust.registerPlugin(plugin);
    expect((plugin as any)._requireGuardrails).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// requireGuardrails inheritance
// ---------------------------------------------------------------------------

describe('requireGuardrails inheritance', () => {
  it('inherits requireGuardrails from client on onInit', () => {
    switchTrust.init({
      provider: 'google',
      gatewayUrl: 'https://api.switchagents.ai',
      apiKey: 'grl_sk_test',
      requireGuardrails: false,
    });
    const plugin = new ADKGuardrailsPlugin();
    switchTrust.registerPlugin(plugin);

    expect((plugin as any)._requireGuardrails).toBe(false);
  });

  it('constructor requireGuardrails takes precedence over client', () => {
    switchTrust.init({
      provider: 'google',
      gatewayUrl: 'https://api.switchagents.ai',
      apiKey: 'grl_sk_test',
      requireGuardrails: false,
    });
    const plugin = new ADKGuardrailsPlugin({ requireGuardrails: true });
    switchTrust.registerPlugin(plugin);

    expect((plugin as any)._requireGuardrails).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Env var configuration
// ---------------------------------------------------------------------------

describe('env var configuration', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('reads from FLINTAI_* env vars', () => {
    vi.stubEnv('FLINTAI_GATEWAY_URL', 'https://guardrails.env.com');
    vi.stubEnv('FLINTAI_API_KEY', 'env-api-key');

    const plugin = new ADKGuardrailsPlugin();

    const cfg = plugin.contentConfig as any;
    expect(cfg).not.toBeNull();
    expect(cfg.httpOptions.baseUrl).toBe('https://guardrails.env.com/gemini/');
    expect(cfg.httpOptions.headers['X-FlintAI-API-Key']).toBe('env-api-key');
  });
});
