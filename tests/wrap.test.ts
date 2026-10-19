import * as switchTrust from '../src/index.js';
import * as core from '../src/core.js';
import { SwitchTrustClient } from '../src/core.js';
import { GuardrailsConfig, SwitchTrustGuardrailsError } from '../src/guardrails.js';
import {
  wrapClient,
  _isWrapped,
  _markWrapped,
  _clearWrapped,
  _detectClientType,
  _detectLangchainModel,
  _checkSdkVersion,
  _sdkVersionWarning,
  parseVersion,
  compareVersions,
  SUPPORTED_SDK_VERSIONS,
} from '../src/plugins/llm-wrapper.js';

const { defaultLoadModule } = vi.hoisted(() => {
  const Agent = class Agent {};
  const Anthropic = class Anthropic {};
  const defaultLoadModule = (name: string) => {
    if (name === '@google/adk') return { Agent };
    if (name === '@anthropic-ai/sdk') return { Anthropic };
    throw new Error(`Module not available in test: ${name}`);
  };
  return { defaultLoadModule };
});

vi.mock('../src/module-loader.js', () => ({
  loadModule: vi.fn(defaultLoadModule),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockClient(constructorName: string, provider: string = 'openai'): any {
  const cls = {
    [constructorName]: class {
      api_key?: string;
    },
  }[constructorName];
  const client = new cls() as any;
  if (provider === 'anthropic') {
    // Mirror the real @anthropic-ai/sdk client: public `baseURL` + `_options.defaultHeaders`.
    client.baseURL = null;
    client._options = { defaultHeaders: {} };
  } else if (provider === 'google') {
    // Mirror the real @google/genai client: apiClient.clientOptions.httpOptions.{baseUrl,headers}.
    client.apiClient = {
      clientOptions: { httpOptions: { baseUrl: 'https://original.com', headers: {} } },
    };
  } else {
    // Mirror the real openai client: public `baseURL` + `_options.defaultHeaders`.
    client.baseURL = null;
    client._options = { defaultHeaders: {} };
  }
  return client;
}

function makeGuardrailsConfig(provider: string = 'openai'): GuardrailsConfig {
  return new GuardrailsConfig({
    baseUrl: `https://gw.example.com/${provider === 'google' ? 'gemini' : provider}`,
    headers: { 'X-FlintAI-API-Key': 'grl_key' },
    provider: provider as any,
    gatewayUrl: 'https://gw.example.com',
  });
}

function makeDeferredConfig(): GuardrailsConfig {
  return new GuardrailsConfig({
    baseUrl: 'https://gw.example.com',
    headers: { 'X-FlintAI-API-Key': 'grl_key' },
    provider: null,
    gatewayUrl: 'https://gw.example.com',
  });
}

// Build a v1.x-shaped LangChain chat model mock (config lives on the model).
function makeLangchainModel(constructorName: string, provider: string): any {
  const cls = { [constructorName]: class {} }[constructorName];
  const model = new cls() as any;
  if (provider === 'openai') {
    // Requests go via completions/responses delegates; clones rebuild from fields.
    model.clientConfig = { apiKey: 'sk-inner-key' };
    model.client = undefined;
    model.completions = { clientConfig: { apiKey: 'sk-inner-key' }, client: undefined };
    model.responses = { clientConfig: { apiKey: 'sk-inner-key' }, client: undefined };
    model.fields = { configuration: {} };
  } else if (provider === 'anthropic') {
    model.apiKey = 'sk-inner-key';
    model.apiUrl = undefined;
    model.clientOptions = {};
    model.batchClient = undefined;
    model.streamingClient = undefined;
  } else {
    // ChatGoogleGenerativeAI: eager GenerativeModel with _requestOptions.
    model.client = { apiKey: 'sk-inner-key', _requestOptions: {} };
  }
  return model;
}

// ---------------------------------------------------------------------------
// Client type detection
// ---------------------------------------------------------------------------

describe('client type detection', () => {
  it.each([
    ['Anthropic', 'anthropic'],
    ['OpenAI', 'openai'],
    ['Client', 'google'],
  ] as const)('detects %s as %s provider', (constructorName, expectedProvider) => {
    const client = makeMockClient(constructorName, expectedProvider);
    expect(_detectClientType(client)).toBe(expectedProvider);
  });

  it.each([
    ['AsyncAnthropic', 'anthropic'],
    ['AsyncOpenAI', 'openai'],
  ] as const)('async client %s raises', (constructorName, provider) => {
    const client = makeMockClient(constructorName, provider);
    expect(() => _detectClientType(client)).toThrow('Async clients are not supported');
  });

  it('unknown type raises', () => {
    const client = makeMockClient('SomeClient', 'unknown');
    expect(() => _detectClientType(client)).toThrow('Unrecognized client type');
  });

  it('rejects ADK Agent with helpful error', async () => {
    vi.resetModules();
    const { loadModule } = await import('../src/module-loader.js');
    const { _detectClientType: detect } = await import('../src/plugins/llm-wrapper.js');
    const AgentClass = (loadModule('@google/adk') as Record<string, unknown>).Agent as { prototype: object };
    const fakeAgent = Object.create(AgentClass.prototype);
    expect(() => detect(fakeAgent)).toThrow('ADKGuardrailsPlugin');
  });

  it('handles client with no constructor (Object.create(null))', () => {
    const bare = Object.create(null);
    expect(() => _detectClientType(bare)).toThrow('Unrecognized client type');
  });

  it('detects via instanceof for real SDK prototypes', async () => {
    vi.resetModules();
    const { loadModule } = await import('../src/module-loader.js');
    const { _detectClientType: detect } = await import('../src/plugins/llm-wrapper.js');
    const AnthropicClass = (loadModule('@anthropic-ai/sdk') as Record<string, unknown>).Anthropic as { prototype: object };
    const fakeClient = Object.create(AnthropicClass.prototype);
    expect(detect(fakeClient)).toBe('anthropic');
  });
});

// ---------------------------------------------------------------------------
// Applying guardrails config
// ---------------------------------------------------------------------------

describe('applying guardrails config', () => {
  it('applies anthropic config', () => {
    const client = makeMockClient('Anthropic', 'anthropic');
    client.baseURL = 'https://api.anthropic.com';
    const sc = new SwitchTrustClient('anthropic');
    sc.guardrailsConfig = makeGuardrailsConfig('anthropic');
    core.setClient(sc);

    wrapClient(client);

    expect(client.baseURL).toBe('https://gw.example.com/anthropic');
    expect(client._baseURLIsExplicit).toBe(true);
    expect(client._options.defaultHeaders['X-FlintAI-API-Key']).toBe('grl_key');
  });

  it('anthropic creates _options.defaultHeaders when absent', () => {
    // A real `new Anthropic({ apiKey })` has `_options` with no `defaultHeaders`
    // key, so this exercises the creation fallback rather than Object.assign.
    const client = makeMockClient('Anthropic', 'anthropic');
    client.baseURL = 'https://api.anthropic.com';
    client._options = { apiKey: 'sk-real' };
    const sc = new SwitchTrustClient('anthropic');
    sc.guardrailsConfig = makeGuardrailsConfig('anthropic');
    core.setClient(sc);

    wrapClient(client);

    expect(client._options.defaultHeaders['X-FlintAI-API-Key']).toBe('grl_key');
    expect(client._options.apiKey).toBe('sk-real');
  });

  it('applies openai with baseURL property setter', () => {
    let internalUrl = 'https://api.openai.com';
    const cls = class OpenAI {
      _options: { defaultHeaders: Record<string, string> } = { defaultHeaders: {} };
      get baseURL() {
        return internalUrl;
      }
      set baseURL(val: string) {
        internalUrl = val;
      }
    };
    const client = new cls();
    const sc = new SwitchTrustClient('openai');
    sc.guardrailsConfig = makeGuardrailsConfig('openai');
    core.setClient(sc);

    wrapClient(client);

    expect(internalUrl).toBe('https://gw.example.com/openai');
    expect(client._options.defaultHeaders['X-FlintAI-API-Key']).toBe('grl_key');
  });

  it('applies openai via public baseURL property', () => {
    const client = makeMockClient('OpenAI', 'openai');
    client.baseURL = 'https://api.openai.com';
    const sc = new SwitchTrustClient('openai');
    sc.guardrailsConfig = makeGuardrailsConfig('openai');
    core.setClient(sc);

    wrapClient(client);

    expect(client.baseURL).toBe('https://gw.example.com/openai');
    expect(client._options.defaultHeaders['X-FlintAI-API-Key']).toBe('grl_key');
  });

  it('normalizes a Headers defaultHeaders and preserves existing entries', () => {
    const client = makeMockClient('OpenAI', 'openai');
    client.baseURL = 'https://api.openai.com';
    const existing = new Headers();
    existing.set('X-Existing', 'keep-me');
    client._options.defaultHeaders = existing;
    const sc = new SwitchTrustClient('openai');
    sc.guardrailsConfig = makeGuardrailsConfig('openai');
    core.setClient(sc);

    wrapClient(client);

    const dh = client._options.defaultHeaders;
    expect(dh instanceof Headers).toBe(false);
    expect(dh['x-existing']).toBe('keep-me');
    expect(dh['X-FlintAI-API-Key']).toBe('grl_key');
  });

  it('preserves a null-suppressed default header when normalizing NullableHeaders', () => {
    // OpenAI's NullableHeaders shape: values holds live headers, nulls tracks keys
    // the caller set to null to drop an SDK default (e.g. `Authorization: null`).
    const client = makeMockClient('OpenAI', 'openai');
    client.baseURL = 'https://api.openai.com';
    const values = new Headers();
    values.set('X-Existing', 'keep-me');
    client._options.defaultHeaders = { values, nulls: new Set(['authorization']) };
    const sc = new SwitchTrustClient('openai');
    sc.guardrailsConfig = makeGuardrailsConfig('openai');
    core.setClient(sc);

    wrapClient(client);

    const dh = client._options.defaultHeaders;
    // The suppression must survive so the SDK doesn't resurrect the default
    // Authorization header the caller deliberately removed.
    expect(dh.authorization).toBeNull();
    expect(dh['x-existing']).toBe('keep-me');
    expect(dh['X-FlintAI-API-Key']).toBe('grl_key');
  });

  it('applies openai falls back to _base_url when present', () => {
    const cls = class OpenAI {
      _base_url = 'https://api.openai.com';
      _options: { defaultHeaders: Record<string, string> } = { defaultHeaders: {} };
    };
    const client = new cls() as any;
    const sc = new SwitchTrustClient('openai');
    sc.guardrailsConfig = makeGuardrailsConfig('openai');
    core.setClient(sc);

    wrapClient(client);

    expect(client._base_url).toBe('https://gw.example.com/openai');
  });

  it('anthropic without baseURL fails closed when guardrails are required', () => {
    const client = makeMockClient('Anthropic', 'anthropic');
    delete (client as any).baseURL;
    const sc = new SwitchTrustClient('anthropic'); // requireGuardrails defaults to true
    sc.guardrailsConfig = makeGuardrailsConfig('anthropic');
    core.setClient(sc);

    expect(() => wrapClient(client)).toThrow(SwitchTrustGuardrailsError);
    expect(() => wrapClient(client)).toThrow('Anthropic');
  });

  it('anthropic without baseURL throws TypeError when guardrails are optional', () => {
    const client = makeMockClient('Anthropic', 'anthropic');
    delete (client as any).baseURL;
    const sc = new SwitchTrustClient('anthropic', false);
    sc.guardrailsConfig = makeGuardrailsConfig('anthropic');
    core.setClient(sc);

    expect(() => wrapClient(client)).toThrow('Cannot set baseURL');
  });

  it('openai without base_url fails closed when guardrails are required', () => {
    const cls = class OpenAI {
      _options: { defaultHeaders: Record<string, string> } = { defaultHeaders: {} };
    };
    const client = new cls();
    const sc = new SwitchTrustClient('openai'); // requireGuardrails defaults to true
    sc.guardrailsConfig = makeGuardrailsConfig('openai');
    core.setClient(sc);

    expect(() => wrapClient(client)).toThrow(SwitchTrustGuardrailsError);
    expect(() => wrapClient(client)).toThrow('not be routed through guardrails');
  });

  it('openai without base_url throws TypeError when guardrails are optional', () => {
    const cls = class OpenAI {
      _options: { defaultHeaders: Record<string, string> } = { defaultHeaders: {} };
    };
    const client = new cls();
    const sc = new SwitchTrustClient('openai', false);
    sc.guardrailsConfig = makeGuardrailsConfig('openai');
    core.setClient(sc);

    expect(() => wrapClient(client)).toThrow('no known attribute found');
  });

  it('google without httpOptions fails closed when guardrails are required', () => {
    const cls = class Client {};
    const client = new cls() as any;
    client.apiClient = { clientOptions: {} }; // no httpOptions
    const sc = new SwitchTrustClient('google'); // requireGuardrails defaults to true
    sc.guardrailsConfig = makeGuardrailsConfig('google');
    core.setClient(sc);

    expect(() => wrapClient(client)).toThrow(SwitchTrustGuardrailsError);
    expect(() => wrapClient(client)).toThrow('not be routed through guardrails');
  });

  it('google without httpOptions throws TypeError when guardrails are optional', () => {
    const cls = class Client {};
    const client = new cls() as any;
    client.apiClient = {}; // no clientOptions/httpOptions
    const sc = new SwitchTrustClient('google', false);
    sc.guardrailsConfig = makeGuardrailsConfig('google');
    core.setClient(sc);

    expect(() => wrapClient(client)).toThrow('httpOptions not found');
  });

  it('fails closed when _options is missing and guardrails are required', () => {
    const client = makeMockClient('Anthropic', 'anthropic');
    client.baseURL = 'https://api.anthropic.com';
    delete (client as any)._options;
    const sc = new SwitchTrustClient('anthropic'); // requireGuardrails defaults to true
    sc.guardrailsConfig = makeGuardrailsConfig('anthropic');
    core.setClient(sc);

    expect(() => wrapClient(client)).toThrow(SwitchTrustGuardrailsError);
    expect(() => wrapClient(client)).toThrow('without authentication');
    // A failed wrap must leave the client untouched — never redirected to the
    // gateway without an auth header.
    expect(client.baseURL).toBe('https://api.anthropic.com');
    expect(client._baseURLIsExplicit).toBeUndefined();
  });

  it('throws TypeError when _options is missing and guardrails are optional', () => {
    const client = makeMockClient('Anthropic', 'anthropic');
    client.baseURL = 'https://api.anthropic.com';
    delete (client as any)._options;
    const sc = new SwitchTrustClient('anthropic', false);
    sc.guardrailsConfig = makeGuardrailsConfig('anthropic');
    core.setClient(sc);

    expect(() => wrapClient(client)).toThrow('Cannot set custom headers');
  });

  it('applies openai with plain baseURL property (no setter, no _base_url)', () => {
    const cls = class OpenAI {
      baseURL = 'https://api.openai.com';
      _options: { defaultHeaders: Record<string, string> } = { defaultHeaders: {} };
    };
    const client = new cls();
    const sc = new SwitchTrustClient('openai');
    sc.guardrailsConfig = makeGuardrailsConfig('openai');
    core.setClient(sc);

    wrapClient(client);

    expect(client.baseURL).toBe('https://gw.example.com/openai');
  });

  it('applies google config via apiClient.clientOptions.httpOptions', () => {
    const client = makeMockClient('Client', 'google');
    const sc = new SwitchTrustClient('google');
    sc.guardrailsConfig = makeGuardrailsConfig('google');
    core.setClient(sc);

    wrapClient(client);

    const httpOpts = client.apiClient.clientOptions.httpOptions;
    expect(httpOpts.baseUrl).toBe('https://gw.example.com/gemini/');
    expect(httpOpts.headers['X-FlintAI-API-Key']).toBe('grl_key');
  });

  it('google creates headers when none exist', () => {
    const cls = class Client {};
    const client = new cls() as any;
    client.apiClient = { clientOptions: { httpOptions: { baseUrl: 'https://original.com' } } };
    const sc = new SwitchTrustClient('google');
    sc.guardrailsConfig = makeGuardrailsConfig('google');
    core.setClient(sc);

    wrapClient(client);

    expect(client.apiClient.clientOptions.httpOptions.headers['X-FlintAI-API-Key']).toBe('grl_key');
  });

  it('google merges with existing headers', () => {
    const cls = class Client {};
    const client = new cls() as any;
    client.apiClient = { clientOptions: { httpOptions: { baseUrl: 'https://original.com', headers: { Existing: 'keep' } } } };
    const sc = new SwitchTrustClient('google');
    sc.guardrailsConfig = makeGuardrailsConfig('google');
    core.setClient(sc);

    wrapClient(client);

    const headers = client.apiClient.clientOptions.httpOptions.headers;
    expect(headers['Existing']).toBe('keep');
    expect(headers['X-FlintAI-API-Key']).toBe('grl_key');
  });
});

// ---------------------------------------------------------------------------
// wrapClient
// ---------------------------------------------------------------------------

describe('wrapClient', () => {
  it('applies guardrails when configured', () => {
    const client = makeMockClient('Anthropic', 'anthropic');
    client.baseURL = 'https://api.anthropic.com';
    const sc = new SwitchTrustClient('anthropic');
    sc.guardrailsConfig = makeGuardrailsConfig('anthropic');
    core.setClient(sc);

    wrapClient(client);

    expect(client.baseURL).toBe('https://gw.example.com/anthropic');
  });

  it('skips guardrails when not configured and requireGuardrails is false', () => {
    const client = makeMockClient('OpenAI', 'openai');
    client.baseURL = 'https://api.openai.com';
    core.setClient(new SwitchTrustClient('openai', false));

    wrapClient(client);

    expect(client.baseURL).toBe('https://api.openai.com');
    expect(client._options.defaultHeaders).toEqual({});
  });

  it('double wrap is noop', () => {
    const warnSpy = vi.spyOn(console, 'warn');
    const client = makeMockClient('OpenAI', 'openai');
    core.setClient(new SwitchTrustClient('openai', false));

    wrapClient(client);
    wrapClient(client);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('already wrapped'));
  });

  it('unknown provider raises', () => {
    const cls = class SomeClient {
      _base_url: string | null = null;
      _custom_headers: Record<string, string> = {};
    };
    const client = new cls();
    core.setClient(new SwitchTrustClient(null, false));

    expect(() => wrapClient(client)).toThrow('Unrecognized client type');
  });
});

// ---------------------------------------------------------------------------
// switchTrust.wrap() public API
// ---------------------------------------------------------------------------

describe('switchTrust.wrap', () => {
  it('auto-inits when no client', () => {
    switchTrust.shutdown();
    expect(core.getClient()).toBeNull();

    const client = makeMockClient('OpenAI', 'openai');
    switchTrust.wrap(client, { requireGuardrails: false });

    expect(core.getClient()).not.toBeNull();
  });

  it('wrap with guardrails params sets headers and base_url', () => {
    const client = makeMockClient('OpenAI', 'openai');
    client.baseURL = 'https://api.openai.com';

    switchTrust.wrap(client, {
      gatewayUrl: 'https://gw.example.com',
      apiKey: 'grl_key',
    });

    expect(client.baseURL).toBe('https://gw.example.com/openai');
    expect(client._options.defaultHeaders['X-FlintAI-API-Key']).toBe('grl_key');
  });

  it('wrap with guardrails params auto-inits when no prior init', () => {
    switchTrust.shutdown();
    expect(core.getClient()).toBeNull();

    const client = makeMockClient('OpenAI', 'openai');
    client.baseURL = 'https://api.openai.com';

    switchTrust.wrap(client, { gatewayUrl: 'https://gw.example.com', apiKey: 'grl_key' });

    expect(core.getClient()).not.toBeNull();
    expect(client.baseURL).toBe('https://gw.example.com/openai');
  });

  it('partial guardrails params raises', () => {
    const client = makeMockClient('OpenAI', 'openai');

    expect(() => switchTrust.wrap(client, { gatewayUrl: 'https://gw.example.com' })).toThrow(/gateway_url and api_key are both required/);
  });

  it('unknown client type raises', () => {
    switchTrust.init({ requireGuardrails: false });

    expect(() => switchTrust.wrap({} as any, { requireGuardrails: false })).toThrow('Unrecognized client type');
  });

  it('preserves user api_key after wrap', () => {
    const client = makeMockClient('Anthropic', 'anthropic');
    client.baseURL = 'https://api.anthropic.com';
    client.api_key = 'sk-real';
    const sc = new SwitchTrustClient('anthropic');
    sc.guardrailsConfig = makeGuardrailsConfig('anthropic');
    core.setClient(sc);

    switchTrust.wrap(client);

    expect(client.api_key).toBe('sk-real');
  });

  it('wrap from env vars', () => {
    process.env.FLINTAI_GATEWAY_URL = 'https://gw.env.com';
    process.env.FLINTAI_API_KEY = 'env-api-key';

    const client = makeMockClient('OpenAI', 'openai');
    client.baseURL = 'https://api.openai.com';

    switchTrust.wrap(client);

    expect(client.baseURL).toBe('https://gw.env.com/openai');
    expect(client._options.defaultHeaders['X-FlintAI-API-Key']).toBe('env-api-key');
  });

  it('explicit params beat env vars', () => {
    process.env.FLINTAI_GATEWAY_URL = 'https://gw.env.com';
    process.env.FLINTAI_API_KEY = 'env-api-key';

    const client = makeMockClient('OpenAI', 'openai');
    client.baseURL = 'https://api.openai.com';

    switchTrust.wrap(client, {
      gatewayUrl: 'https://explicit.com',
      apiKey: 'explicit-key',
    });

    expect(client.baseURL).toBe('https://explicit.com/openai');
    expect(client._options.defaultHeaders['X-FlintAI-API-Key']).toBe('explicit-key');
  });
});

// ---------------------------------------------------------------------------
// Google-specific
// ---------------------------------------------------------------------------

describe('google-specific', () => {
  it('applies google guardrails with trailing slash on base_url', () => {
    const client = makeMockClient('Client', 'google');
    const sc = new SwitchTrustClient('google');
    sc.guardrailsConfig = makeGuardrailsConfig('google');
    core.setClient(sc);

    wrapClient(client);

    const httpOptions = (client as any).apiClient.clientOptions.httpOptions;
    expect(httpOptions.baseUrl).toMatch(/\/$/);
    expect(httpOptions.headers['X-FlintAI-API-Key']).toBe('grl_key');
  });
});

// ---------------------------------------------------------------------------
// Deferred provider
// ---------------------------------------------------------------------------

describe('deferred provider', () => {
  it.each([
    ['OpenAI', 'client', 'openai', 'https://gw.example.com/openai'],
    ['Anthropic', 'client', 'anthropic', 'https://gw.example.com/anthropic'],
    ['Client', 'client', 'google', 'https://gw.example.com/gemini/'],
  ] as const)('resolves URL at wrap time for %s', (constructorName, _attr, provider, expectedUrl) => {
    const client = makeMockClient(constructorName, provider);
    if (provider === 'openai' || provider === 'anthropic') {
      client.baseURL = `https://api.${provider}.com`;
    }
    const sc = new SwitchTrustClient(null);
    sc.guardrailsConfig = makeDeferredConfig();
    core.setClient(sc);

    wrapClient(client);

    const actualUrl = provider === 'google' ? (client as any).apiClient.clientOptions.httpOptions.baseUrl : client.baseURL;
    expect(actualUrl).toBe(expectedUrl);
  });
});

// ---------------------------------------------------------------------------
// LangChain wrapping
// ---------------------------------------------------------------------------

describe('LangChain wrapping', () => {
  // Read the config fields wrap() should have set on a v1.x LangChain model.
  function readConfig(model: any, provider: string): { baseUrl: unknown; headers: Record<string, string> } {
    if (provider === 'openai') {
      // completions is the default request-path delegate.
      return { baseUrl: model.completions.clientConfig.baseURL, headers: model.completions.clientConfig.defaultHeaders };
    }
    if (provider === 'anthropic') {
      return { baseUrl: model.apiUrl, headers: model.clientOptions.defaultHeaders };
    }
    return { baseUrl: model.client._requestOptions.baseUrl, headers: model.client._requestOptions.customHeaders };
  }

  it.each([
    ['ChatOpenAI', 'openai'],
    ['ChatAnthropic', 'anthropic'],
    ['ChatGoogleGenerativeAI', 'google'],
  ] as const)('_detectLangchainModel returns [model, provider] for %s', (constructorName, provider) => {
    const model = makeLangchainModel(constructorName, provider);
    const result = _detectLangchainModel(model);
    expect(result).not.toBeNull();
    const [detected, detectedProvider] = result!;
    expect(detected).toBe(model);
    expect(detectedProvider).toBe(provider);
  });

  it.each([
    ['ChatOpenAI', 'openai'],
    ['ChatAnthropic', 'anthropic'],
    ['ChatGoogleGenerativeAI', 'google'],
  ] as const)('wrapClient applies guardrails to model config for %s', (constructorName, provider) => {
    const model = makeLangchainModel(constructorName, provider);
    const sc = new SwitchTrustClient(provider as any);
    sc.guardrailsConfig = makeGuardrailsConfig(provider);
    core.setClient(sc);

    wrapClient(model);

    const expectedPath = provider === 'google' ? 'gemini' : provider;
    const { baseUrl, headers } = readConfig(model, provider);
    expect(baseUrl).toBe(`https://gw.example.com/${expectedPath}`);
    expect(headers['X-FlintAI-API-Key']).toBe('grl_key');
  });

  it('detect returns null for non-langchain client', () => {
    const client = makeMockClient('OpenAI', 'openai');
    expect(_detectLangchainModel(client)).toBeNull();
  });

  it('openai wrap configures both completions and responses delegates', () => {
    const model = makeLangchainModel('ChatOpenAI', 'openai');
    const sc = new SwitchTrustClient('openai');
    sc.guardrailsConfig = makeGuardrailsConfig('openai');
    core.setClient(sc);

    wrapClient(model);

    for (const delegate of ['completions', 'responses'] as const) {
      expect(model[delegate].clientConfig.baseURL).toBe('https://gw.example.com/openai');
      expect(model[delegate].clientConfig.defaultHeaders['X-FlintAI-API-Key']).toBe('grl_key');
    }
  });

  it('openai wrap patches retained fields.configuration so clones inherit routing', () => {
    const model = makeLangchainModel('ChatOpenAI', 'openai');
    const sc = new SwitchTrustClient('openai');
    sc.guardrailsConfig = makeGuardrailsConfig('openai');
    core.setClient(sc);

    wrapClient(model);

    // bindTools/withConfig clone via new ChatOpenAI(model.fields), so fields must route.
    expect(model.fields.configuration.baseURL).toBe('https://gw.example.com/openai');
    expect(model.fields.configuration.defaultHeaders['X-FlintAI-API-Key']).toBe('grl_key');
  });

  it('google model without client raises when guardrails required', () => {
    const model = makeLangchainModel('ChatGoogleGenerativeAI', 'google');
    model.client = undefined;
    const sc = new SwitchTrustClient('google', true);
    sc.guardrailsConfig = makeGuardrailsConfig('google');
    core.setClient(sc);

    expect(() => wrapClient(model)).toThrow(/GenerativeModel.*not found/);
  });

  it('double wrap langchain is noop', () => {
    const warnSpy = vi.spyOn(console, 'warn');
    const model = makeLangchainModel('ChatOpenAI', 'openai');
    core.setClient(new SwitchTrustClient('openai', false));

    wrapClient(model);
    wrapClient(model);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('already wrapped'));
  });

  it('langchain with policy_id sets header on model config', () => {
    const model = makeLangchainModel('ChatOpenAI', 'openai');

    switchTrust.wrap(model, {
      gatewayUrl: 'https://gw.example.com',
      apiKey: 'grl_key',
      policyId: 'pol-1',
    });

    expect(model.clientConfig.defaultHeaders['X-Guardrails-Policy-Id']).toBe('pol-1');
  });

  it.each([
    ['ChatOpenAI', 'openai'],
    ['ChatAnthropic', 'anthropic'],
    ['ChatGoogleGenerativeAI', 'google'],
  ] as const)('_clearWrapped restores original config for %s', (constructorName, provider) => {
    const model = makeLangchainModel(constructorName, provider);
    const before = readConfig(model, provider);
    const sc = new SwitchTrustClient(provider as any);
    sc.guardrailsConfig = makeGuardrailsConfig(provider);
    core.setClient(sc);

    wrapClient(model);
    _clearWrapped();

    const after = readConfig(model, provider);
    expect(after.baseUrl).toBe(before.baseUrl);
    expect('X-FlintAI-API-Key' in (after.headers ?? {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WeakSet tracking
// ---------------------------------------------------------------------------

describe('WeakSet tracking', () => {
  it('isWrapped false before mark', () => {
    _clearWrapped();
    const obj = {};
    expect(_isWrapped(obj)).toBe(false);
  });

  it('mark and check', () => {
    _clearWrapped();
    const obj = {};
    _markWrapped(obj);
    expect(_isWrapped(obj)).toBe(true);
  });

  it('shutdown clears tracking', () => {
    const client = makeMockClient('OpenAI', 'openai');
    core.setClient(new SwitchTrustClient('openai', false));
    wrapClient(client);
    expect(_isWrapped(client)).toBe(true);

    switchTrust.shutdown();

    expect(_isWrapped(client)).toBe(false);
  });

  it('_markWrapped logs warning when add throws', () => {
    const warnSpy = vi.spyOn(console, 'warn');
    const origAdd = WeakSet.prototype.add;
    WeakSet.prototype.add = () => {
      throw new Error('boom');
    };
    try {
      _markWrapped({});
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cannot track wrapped client'));
    } finally {
      WeakSet.prototype.add = origAdd;
    }
  });
});

// ---------------------------------------------------------------------------
// Agent identity
// ---------------------------------------------------------------------------

describe('agent identity', () => {
  it('agent_name sets X-Agent-Name header directly', () => {
    const client = makeMockClient('Anthropic', 'anthropic');
    client.baseURL = 'https://api.anthropic.com';

    switchTrust.wrap(client, {
      gatewayUrl: 'https://gw.example.com',
      apiKey: 'grl_key',
      agentName: 'search_agent',
    });

    expect(client._options.defaultHeaders['X-Agent-Name']).toBe('search_agent');
  });

  it('explicit agent_id sets X-Agent-Id header as-is', () => {
    const client = makeMockClient('Anthropic', 'anthropic');
    client.baseURL = 'https://api.anthropic.com';

    switchTrust.wrap(client, {
      gatewayUrl: 'https://gw.example.com',
      apiKey: 'grl_key',
      agentId: 'custom_id',
    });

    expect(client._options.defaultHeaders['X-Agent-Id']).toBe('custom_id');
  });
});

// ---------------------------------------------------------------------------
// SDK version checking
// ---------------------------------------------------------------------------

describe('parseVersion', () => {
  it.each([
    ['6.41.0', [6, 41, 0]],
    ['0.100.1', [0, 100, 1]],
    ['3', [3]],
    ['2.8', [2, 8]],
    ['1.0.0rc1', [1, 0, 0]],
  ] as const)('parses %s', (input, expected) => {
    expect(parseVersion(input)).toEqual(expected);
  });

  it('returns null for garbage', () => {
    expect(parseVersion('abc')).toBeNull();
  });
});

describe('compareVersions', () => {
  it('equal versions return 0', () => {
    expect(compareVersions([2, 40, 0], [2, 40, 0])).toBe(0);
  });

  it('lower version returns negative', () => {
    expect(compareVersions([2, 30, 0], [2, 40, 0])).toBeLessThan(0);
  });

  it('higher version returns positive', () => {
    expect(compareVersions([3, 0, 0], [2, 40, 0])).toBeGreaterThan(0);
  });

  it('pads shorter arrays with zeros', () => {
    expect(compareVersions([2], [2, 0, 0])).toBe(0);
  });
});

describe('SUPPORTED_SDK_VERSIONS', () => {
  it('defines entries for all providers', () => {
    expect(SUPPORTED_SDK_VERSIONS).toHaveProperty('openai');
    expect(SUPPORTED_SDK_VERSIONS).toHaveProperty('anthropic');
    expect(SUPPORTED_SDK_VERSIONS).toHaveProperty('google');
  });

  it.each(Object.entries(SUPPORTED_SDK_VERSIONS))('%s entry has required fields', (_provider, entry) => {
    expect(entry.pkg).toBeTruthy();
    expect(entry.min.length).toBeGreaterThan(0);
    expect(entry.maxMajor).toBeGreaterThan(0);
  });
});

describe('_sdkVersionWarning', () => {
  it('returns null for an unknown provider', () => {
    expect(_sdkVersionWarning('cohere' as any, '1.0.0')).toBeNull();
  });

  it('returns null for an unparseable version', () => {
    expect(_sdkVersionWarning('openai', 'not-a-version')).toBeNull();
  });

  it('returns null for a supported version', () => {
    expect(_sdkVersionWarning('openai', '6.41.0')).toBeNull();
    expect(_sdkVersionWarning('openai', '6.99.0')).toBeNull();
  });

  it('warns when the installed version is older than the supported minimum', () => {
    const msg = _sdkVersionWarning('openai', '6.40.0');
    expect(msg).toContain('openai 6.40.0');
    expect(msg).toContain('>=6.41.0,<7');
  });

  it('warns when the installed major exceeds the supported range', () => {
    const msg = _sdkVersionWarning('openai', '7.0.0');
    expect(msg).toContain('openai 7.0.0');
    expect(msg).toContain('>=6.41.0,<7');
  });

  it('warns for each provider outside its range', () => {
    expect(_sdkVersionWarning('anthropic', '0.100.0')).toContain('@anthropic-ai/sdk');
    expect(_sdkVersionWarning('google', '3.0.0')).toContain('@google/genai');
  });
});

describe('_checkSdkVersion', () => {
  it('does not throw for unknown provider', () => {
    expect(() => _checkSdkVersion('cohere' as any)).not.toThrow();
  });

  it('does not warn for the installed (supported) SDK versions', () => {
    // The real installed versions are pinned within the supported ranges, so the
    // end-to-end path (resolve version from package.json + compare) stays quiet.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    _checkSdkVersion('openai');
    _checkSdkVersion('anthropic');
    _checkSdkVersion('google');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// requireGuardrails enforcement
// ---------------------------------------------------------------------------

describe('requireGuardrails', () => {
  it('wrap throws SwitchTrustGuardrailsError by default when no config', () => {
    const client = makeMockClient('OpenAI', 'openai');
    expect(() => switchTrust.wrap(client)).toThrow(SwitchTrustGuardrailsError);
  });

  it('wrap with requireGuardrails: false succeeds without config', () => {
    const client = makeMockClient('OpenAI', 'openai');
    expect(() => switchTrust.wrap(client, { requireGuardrails: false })).not.toThrow();
  });

  it('wrapClient throws when client.requireGuardrails is true and no config', () => {
    const client = makeMockClient('OpenAI', 'openai');
    client.baseURL = 'https://api.openai.com';
    const sc = new SwitchTrustClient('openai', true);
    core.setClient(sc);

    expect(() => wrapClient(client)).toThrow(SwitchTrustGuardrailsError);
  });

  it('wrapClient throws for langchain when requireGuardrails is true and no config', () => {
    const model = makeLangchainModel('ChatOpenAI', 'openai');
    const sc = new SwitchTrustClient('openai', true);
    core.setClient(sc);

    expect(() => wrapClient(model)).toThrow(SwitchTrustGuardrailsError);
  });

  it('wrapClient skips guardrails when client.requireGuardrails is false and no config', () => {
    const client = makeMockClient('OpenAI', 'openai');
    client.baseURL = 'https://api.openai.com';
    const sc = new SwitchTrustClient('openai', false);
    core.setClient(sc);

    wrapClient(client);
    expect(client.baseURL).toBe('https://api.openai.com');
  });
});

// ---------------------------------------------------------------------------
// Opt-out audit warning across provider paths
// ---------------------------------------------------------------------------

describe('opt-out audit warning (wrap)', () => {
  it.each([
    ['OpenAI', 'openai'],
    ['Anthropic', 'anthropic'],
    ['GoogleGenAI', 'google'],
  ])('wrap(%s) with requireGuardrails: false emits the audit warning', (ctor, provider) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = makeMockClient(ctor, provider);
    switchTrust.wrap(client, { requireGuardrails: false });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SECURITY CONTROL DISABLED'));
    warn.mockRestore();
  });

  it('wrap() with dangerouslyDisableGuardrails: true emits the audit warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = makeMockClient('OpenAI', 'openai');
    switchTrust.wrap(client, { dangerouslyDisableGuardrails: true });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SECURITY CONTROL DISABLED'));
    warn.mockRestore();
  });

  it('wrap() throws when dangerouslyDisableGuardrails and requireGuardrails: true conflict', () => {
    const client = makeMockClient('OpenAI', 'openai');
    expect(() => switchTrust.wrap(client, { dangerouslyDisableGuardrails: true, requireGuardrails: true })).toThrow(/Conflicting options/);
  });

  it('guarded wrap does not emit the audit warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = makeMockClient('OpenAI', 'openai');
    client.baseURL = 'https://api.openai.com';
    switchTrust.wrap(client, { gatewayUrl: 'https://gw.example.com', apiKey: 'grl_key' });
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('SECURITY CONTROL DISABLED'));
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Client restoration on shutdown
// ---------------------------------------------------------------------------

describe('client restoration on shutdown', () => {
  it('restores anthropic client on shutdown', () => {
    const client = makeMockClient('Anthropic', 'anthropic');
    client.baseURL = 'https://api.anthropic.com';
    // Client built with profile/config auth and no explicit baseURL.
    client._baseURLIsExplicit = false;
    const sc = new SwitchTrustClient('anthropic');
    sc.guardrailsConfig = makeGuardrailsConfig('anthropic');
    core.setClient(sc);

    wrapClient(client);
    expect(client.baseURL).toBe('https://gw.example.com/anthropic');
    expect(client._baseURLIsExplicit).toBe(true);
    expect(client._options.defaultHeaders['X-FlintAI-API-Key']).toBe('grl_key');

    switchTrust.shutdown();

    expect(client.baseURL).toBe('https://api.anthropic.com');
    // Must restore the original flag, or the SDK can never re-adopt its
    // profile-resolved host after shutdown.
    expect(client._baseURLIsExplicit).toBe(false);
    expect('X-FlintAI-API-Key' in client._options.defaultHeaders).toBe(false);
  });

  it('restores openai client on shutdown', () => {
    const client = makeMockClient('OpenAI', 'openai');
    client.baseURL = 'https://api.openai.com';
    const sc = new SwitchTrustClient('openai');
    sc.guardrailsConfig = makeGuardrailsConfig('openai');
    core.setClient(sc);

    wrapClient(client);
    expect(client.baseURL).toBe('https://gw.example.com/openai');

    switchTrust.shutdown();

    expect(client.baseURL).toBe('https://api.openai.com');
    expect('X-FlintAI-API-Key' in client._options.defaultHeaders).toBe(false);
  });

  it('restores openai client with baseURL setter on shutdown', () => {
    let internalUrl = 'https://api.openai.com';
    const cls = class OpenAI {
      _options: { defaultHeaders: Record<string, string> } = { defaultHeaders: {} };
      get baseURL() {
        return internalUrl;
      }
      set baseURL(val: string) {
        internalUrl = val;
      }
    };
    const client = new cls();
    const sc = new SwitchTrustClient('openai');
    sc.guardrailsConfig = makeGuardrailsConfig('openai');
    core.setClient(sc);

    wrapClient(client);
    expect(internalUrl).toBe('https://gw.example.com/openai');

    switchTrust.shutdown();

    expect(internalUrl).toBe('https://api.openai.com');
    expect('X-FlintAI-API-Key' in client._options.defaultHeaders).toBe(false);
  });

  it('restores google client on shutdown', () => {
    const client = makeMockClient('Client', 'google');
    const originalBaseUrl = client.apiClient.clientOptions.httpOptions.baseUrl;
    const sc = new SwitchTrustClient('google');
    sc.guardrailsConfig = makeGuardrailsConfig('google');
    core.setClient(sc);

    wrapClient(client);
    expect(client.apiClient.clientOptions.httpOptions.headers['X-FlintAI-API-Key']).toBe('grl_key');

    switchTrust.shutdown();

    expect(client.apiClient.clientOptions.httpOptions.baseUrl).toBe(originalBaseUrl);
    expect('X-FlintAI-API-Key' in client.apiClient.clientOptions.httpOptions.headers).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Restoration failure handling (fault injection)
// ---------------------------------------------------------------------------

describe('restoration failure handling', () => {
  // openai client whose baseURL setter can be flipped to throw during restore.
  function makeFaultyOpenAIClient(): { client: any; getUrl: () => string; setFault: (v: boolean) => void } {
    let internalUrl = 'https://api.openai.com';
    let fault = false;
    const cls = class OpenAI {
      _options: { defaultHeaders: Record<string, string> } = { defaultHeaders: {} };
      get baseURL() {
        return internalUrl;
      }
      set baseURL(val: string) {
        if (fault) throw new Error('restore blew up referencing https://gw.example.com/openai and grl_key');
        internalUrl = val;
      }
    };
    return {
      client: new cls(),
      getUrl: () => internalUrl,
      setFault: (v: boolean) => {
        fault = v;
      },
    };
  }

  it('logs a high-visibility error without secrets when restore fails', () => {
    const { client, setFault } = makeFaultyOpenAIClient();
    const sc = new SwitchTrustClient('openai');
    sc.guardrailsConfig = makeGuardrailsConfig('openai');
    core.setClient(sc);

    wrapClient(client);
    expect(_isWrapped(client)).toBe(true);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setFault(true);
    _clearWrapped();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const msg = errorSpy.mock.calls[0][0] as string;
    expect(msg).toContain('failed to restore');
    expect(msg).toContain('openai');
    expect(msg).toContain('OpenAI');
    // No secrets in the message.
    expect(msg).not.toContain('gw.example.com');
    expect(msg).not.toContain('grl_key');
    expect(msg).not.toContain('api.openai.com');
    expect(msg).not.toContain('blew up');

    setFault(false); // let afterEach shutdown() drop the client
  });

  it('preserves failed restoration state for retry', () => {
    const { client, getUrl, setFault } = makeFaultyOpenAIClient();
    const sc = new SwitchTrustClient('openai');
    sc.guardrailsConfig = makeGuardrailsConfig('openai');
    core.setClient(sc);

    wrapClient(client);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setFault(true);
    _clearWrapped();

    // Restore threw before headers were cleared: still gateway-routed, still
    // tracked for retry.
    expect(getUrl()).toBe('https://gw.example.com/openai');
    expect(client._options.defaultHeaders['X-FlintAI-API-Key']).toBe('grl_key');
    expect(_isWrapped(client)).toBe(true);

    setFault(false);
  });

  it('retries on next shutdown and clears state once restore succeeds', () => {
    const { client, getUrl, setFault } = makeFaultyOpenAIClient();
    const sc = new SwitchTrustClient('openai');
    sc.guardrailsConfig = makeGuardrailsConfig('openai');
    core.setClient(sc);

    wrapClient(client);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setFault(true);
    _clearWrapped();
    expect(_isWrapped(client)).toBe(true);

    setFault(false);
    _clearWrapped();

    expect(getUrl()).toBe('https://api.openai.com');
    expect('X-FlintAI-API-Key' in client._options.defaultHeaders).toBe(false);
    expect(_isWrapped(client)).toBe(false);
    // Only the first (failed) attempt logged.
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('one client failure does not block restoration of others', () => {
    const faulty = makeFaultyOpenAIClient();
    const healthy = makeMockClient('OpenAI', 'openai');
    healthy.baseURL = 'https://api.openai.com';
    const sc = new SwitchTrustClient('openai');
    sc.guardrailsConfig = makeGuardrailsConfig('openai');
    core.setClient(sc);

    wrapClient(faulty.client);
    wrapClient(healthy);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    faulty.setFault(true);
    _clearWrapped();

    // Healthy client fully restored and untracked; faulty one retained.
    expect(healthy.baseURL).toBe('https://api.openai.com');
    expect('X-FlintAI-API-Key' in healthy._options.defaultHeaders).toBe(false);
    expect(_isWrapped(healthy)).toBe(false);
    expect(_isWrapped(faulty.client)).toBe(true);

    faulty.setFault(false);
  });
});

// ---------------------------------------------------------------------------
// LangChain restoration failure handling (fault injection)
// ---------------------------------------------------------------------------

describe('langchain restoration failure handling', () => {
  // ChatAnthropic-shaped model whose apiUrl setter can be flipped to throw during restore.
  function makeFaultyLangchainAnthropicModel(): { model: any; getUrl: () => string | undefined; setFault: (v: boolean) => void } {
    let internalUrl: string | undefined;
    let fault = false;
    const cls = class ChatAnthropic {
      clientOptions: Record<string, unknown> = {};
      batchClient: undefined;
      streamingClient: undefined;
      get apiUrl() {
        return internalUrl;
      }
      set apiUrl(val: string | undefined) {
        if (fault) throw new Error('restore blew up referencing https://gw.example.com/anthropic and grl_key');
        internalUrl = val;
      }
    };
    return {
      model: new cls(),
      getUrl: () => internalUrl,
      setFault: (v: boolean) => {
        fault = v;
      },
    };
  }

  it('logs a high-visibility error without secrets when langchain restore fails', () => {
    const { model, setFault } = makeFaultyLangchainAnthropicModel();
    const sc = new SwitchTrustClient('anthropic');
    sc.guardrailsConfig = makeGuardrailsConfig('anthropic');
    core.setClient(sc);

    wrapClient(model);
    expect(_isWrapped(model)).toBe(true);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setFault(true);
    _clearWrapped();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const msg = errorSpy.mock.calls[0][0] as string;
    expect(msg).toContain('failed to restore');
    expect(msg).toContain('LangChain');
    expect(msg).toContain('ChatAnthropic');
    // No secrets in the message.
    expect(msg).not.toContain('gw.example.com');
    expect(msg).not.toContain('grl_key');
    expect(msg).not.toContain('blew up');

    setFault(false);
  });

  it('preserves failed langchain restoration state for retry', () => {
    const { model, getUrl, setFault } = makeFaultyLangchainAnthropicModel();
    const sc = new SwitchTrustClient('anthropic');
    sc.guardrailsConfig = makeGuardrailsConfig('anthropic');
    core.setClient(sc);

    wrapClient(model);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setFault(true);
    _clearWrapped();

    // Restore threw before headers were cleared: still gateway-routed, still tracked for retry.
    expect(getUrl()).toBe('https://gw.example.com/anthropic');
    expect((model.clientOptions.defaultHeaders as Record<string, string>)['X-FlintAI-API-Key']).toBe('grl_key');
    expect(_isWrapped(model)).toBe(true);

    setFault(false);
  });

  it('retries langchain restore on next shutdown and clears state once it succeeds', () => {
    const { model, getUrl, setFault } = makeFaultyLangchainAnthropicModel();
    const sc = new SwitchTrustClient('anthropic');
    sc.guardrailsConfig = makeGuardrailsConfig('anthropic');
    core.setClient(sc);

    wrapClient(model);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setFault(true);
    _clearWrapped();
    expect(_isWrapped(model)).toBe(true);

    setFault(false);
    _clearWrapped();

    expect(getUrl()).toBeUndefined();
    expect('X-FlintAI-API-Key' in (model.clientOptions.defaultHeaders as Record<string, string>)).toBe(false);
    expect(_isWrapped(model)).toBe(false);
    // Only the first (failed) attempt logged.
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
