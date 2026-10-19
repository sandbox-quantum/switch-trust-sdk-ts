import * as switchTrust from '../src/index.js';
import { LangChainGuardrailsMiddleware } from '../src/plugins/langchain.js';
import { _isWrapped } from '../src/plugins/llm-wrapper.js';
import { SwitchTrustGuardrailsError } from '../src/guardrails.js';
import { vi } from 'vitest';

// LangChain packages are peers the SDK never installs; detection falls back to
// the constructor name, so these fakes stand in for the real model classes.
vi.mock('../src/module-loader.js', () => ({
  loadModule: vi.fn((name: string) => {
    throw new Error(`Module not available in test: ${name}`);
  }),
}));

const GATEWAY = { gatewayUrl: 'https://gw.example.com', apiKey: 'grl_key' };

function makeModel(provider: 'openai' | 'anthropic' | 'google'): any {
  const name = { openai: 'ChatOpenAI', anthropic: 'ChatAnthropic', google: 'ChatGoogleGenerativeAI' }[provider];
  const model = new { [name]: class {} }[name]() as any;
  if (provider === 'openai') {
    model.clientConfig = {};
    model.completions = { clientConfig: {} };
    model.responses = { clientConfig: {} };
    model.fields = { configuration: {} };
  } else if (provider === 'anthropic') {
    model.clientOptions = {};
  } else {
    model.client = { _requestOptions: {}, generateContent() {} };
  }
  return model;
}

function makeRequest(model: unknown, opts: { threadId?: string; humanIds?: string[]; modelSettings?: Record<string, unknown> } = {}): any {
  const messages = (opts.humanIds ?? []).flatMap((id) => [
    { type: 'human', id, content: 'hi' },
    { type: 'ai', id: `ai-${id}`, content: '' },
    { type: 'tool', id: `tool-${id}`, content: 'result' },
  ]);
  return {
    model,
    messages,
    state: { messages },
    runtime: opts.threadId ? { configurable: { thread_id: opts.threadId } } : {},
    ...(opts.modelSettings ? { modelSettings: opts.modelSettings } : {}),
  };
}

const passThrough = () => vi.fn(async (request: any) => request);

afterEach(() => {
  delete process.env.AGENT_ID;
  delete process.env.AGENT_NAME;
});

describe('middleware object', () => {
  it('is a createAgent middleware: branded, named, with wrapModelCall', () => {
    const plugin = new LangChainGuardrailsMiddleware(GATEWAY);
    expect(plugin.middleware[Symbol.for('AgentMiddleware')]).toBe(true);
    expect(plugin.middleware.name).toBe('langchain-guardrails');
    expect(typeof plugin.middleware.wrapModelCall).toBe('function');
  });

  it('rejects dangerouslyDisableGuardrails together with requireGuardrails: true', () => {
    expect(() => new LangChainGuardrailsMiddleware({ ...GATEWAY, dangerouslyDisableGuardrails: true, requireGuardrails: true })).toThrow(/Conflicting options/);
  });
});

describe('routing', () => {
  it('routes the model through the proxy on the first call, once', async () => {
    const plugin = new LangChainGuardrailsMiddleware(GATEWAY);
    const model = makeModel('openai');
    const handler = passThrough();

    await plugin.wrapModelCall(makeRequest(model), handler);
    expect(model.completions.clientConfig.baseURL).toBe('https://gw.example.com/openai');
    expect(model.completions.clientConfig.defaultHeaders['X-FlintAI-API-Key']).toBe('grl_key');
    expect(_isWrapped(model)).toBe(true);

    model.completions.clientConfig.baseURL = 'sentinel';
    await plugin.wrapModelCall(makeRequest(model), handler);
    expect(model.completions.clientConfig.baseURL).toBe('sentinel');
  });

  it('sends AGENT_ID and AGENT_NAME as static headers on the routed client', async () => {
    process.env.AGENT_ID = 'agn_123';
    process.env.AGENT_NAME = 'expense-tracker';
    const plugin = new LangChainGuardrailsMiddleware(GATEWAY);
    const model = makeModel('anthropic');

    await plugin.wrapModelCall(makeRequest(model), passThrough());

    expect(model.clientOptions.defaultHeaders['X-Agent-Id']).toBe('agn_123');
    expect(model.clientOptions.defaultHeaders['X-Agent-Name']).toBe('expense-tracker');
  });

  it('routes the provider model behind a ConfigurableModel (model given as a string)', async () => {
    const plugin = new LangChainGuardrailsMiddleware(GATEWAY);
    const inner = makeModel('openai');
    const configurable = { _getModelInstance: vi.fn(async () => inner) };
    const handler = passThrough();

    await plugin.wrapModelCall(makeRequest(configurable, { threadId: 's1' }), handler);

    expect(inner.completions.clientConfig.baseURL).toBe('https://gw.example.com/openai');
    expect(handler.mock.calls[0][0].model).toBe(inner);
  });

  it('fails closed on an unsupported model when guardrails are required', async () => {
    const plugin = new LangChainGuardrailsMiddleware(GATEWAY);
    const handler = passThrough();
    await expect(plugin.wrapModelCall(makeRequest({ constructor: { name: 'SomethingElse' } }), handler)).rejects.toThrow(SwitchTrustGuardrailsError);
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes an unsupported model through when guardrails are not required', async () => {
    const plugin = new LangChainGuardrailsMiddleware({ ...GATEWAY, requireGuardrails: false });
    const request = makeRequest({ unknown: true });
    const handler = passThrough();
    await plugin.wrapModelCall(request, handler);
    expect(handler).toHaveBeenCalledWith(request);
  });

  it('fails closed without a guardrails config when required', async () => {
    const plugin = new LangChainGuardrailsMiddleware();
    await expect(plugin.wrapModelCall(makeRequest(makeModel('openai')), passThrough())).rejects.toThrow(/no config was found/);
  });

  it('passes through unrouted without a config when not required', async () => {
    const warnSpy = vi.spyOn(console, 'warn');
    const plugin = new LangChainGuardrailsMiddleware({ requireGuardrails: false });
    const model = makeModel('openai');
    const request = makeRequest(model, { threadId: 's1', humanIds: ['h1'] });
    const handler = passThrough();

    await plugin.wrapModelCall(request, handler);

    expect(handler).toHaveBeenCalledWith(request);
    expect(model.completions.clientConfig.baseURL).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not routed'));
  });
});

describe('session and turn headers', () => {
  it('OpenAI: sent via modelSettings.options.headers, merged without mutating the caller', async () => {
    const plugin = new LangChainGuardrailsMiddleware(GATEWAY);
    const callerSettings = { temperature: 0, options: { headers: { 'X-Custom': '1' }, timeout: 5 } };
    const request = makeRequest(makeModel('openai'), { threadId: 'sess-1', humanIds: ['turn-1'], modelSettings: callerSettings });
    const handler = passThrough();

    await plugin.wrapModelCall(request, handler);

    const sent = handler.mock.calls[0][0].modelSettings;
    expect(sent.options.headers).toEqual({ 'X-Custom': '1', 'X-Agent-Session-Id': 'sess-1', 'X-Agent-Turn-Id': 'turn-1' });
    expect(sent.options.timeout).toBe(5);
    expect(sent.temperature).toBe(0);
    expect(callerSettings.options.headers).toEqual({ 'X-Custom': '1' });
  });

  it('Anthropic: sent via modelSettings.headers', async () => {
    const plugin = new LangChainGuardrailsMiddleware(GATEWAY);
    const handler = passThrough();
    await plugin.wrapModelCall(makeRequest(makeModel('anthropic'), { threadId: 'sess-1', humanIds: ['turn-1'] }), handler);
    expect(handler.mock.calls[0][0].modelSettings.headers).toEqual({ 'X-Agent-Session-Id': 'sess-1', 'X-Agent-Turn-Id': 'turn-1' });
  });

  it('Google: sent on a per-call model clone; the shared client is untouched', async () => {
    const plugin = new LangChainGuardrailsMiddleware(GATEWAY);
    const model = makeModel('google');
    const handler = passThrough();

    await plugin.wrapModelCall(makeRequest(model, { threadId: 'sess-1', humanIds: ['turn-1'] }), handler);

    const sentModel = handler.mock.calls[0][0].model;
    expect(sentModel).not.toBe(model);
    expect(Object.getPrototypeOf(sentModel)).toBe(model);
    expect(typeof sentModel.client.generateContent).toBe('function');
    expect(sentModel.client._requestOptions.baseUrl).toBe('https://gw.example.com/gemini');
    expect(sentModel.client._requestOptions.customHeaders).toMatchObject({
      'X-FlintAI-API-Key': 'grl_key',
      'X-Agent-Session-Id': 'sess-1',
      'X-Agent-Turn-Id': 'turn-1',
    });
    expect(model.client._requestOptions.customHeaders['X-Agent-Session-Id']).toBeUndefined();
    expect(model.client._requestOptions.customHeaders['X-Agent-Turn-Id']).toBeUndefined();
  });

  it('turn id is the latest user message: stable across the tool loop, new per message', async () => {
    const plugin = new LangChainGuardrailsMiddleware(GATEWAY);
    const model = makeModel('anthropic');
    const handler = passThrough();

    await plugin.wrapModelCall(makeRequest(model, { humanIds: ['turn-1'] }), handler);
    const toolLoop = makeRequest(model, { humanIds: ['turn-1'] });
    toolLoop.state.messages.push({ type: 'ai', id: 'ai-2' }, { type: 'tool', id: 'tool-2' });
    await plugin.wrapModelCall(toolLoop, handler);
    await plugin.wrapModelCall(makeRequest(model, { humanIds: ['turn-1', 'turn-2'] }), handler);

    const turnIds = handler.mock.calls.map((c) => c[0].modelSettings.headers['X-Agent-Turn-Id']);
    expect(turnIds).toEqual(['turn-1', 'turn-1', 'turn-2']);
  });

  it('hashes a user message id the proxy would reject', async () => {
    const plugin = new LangChainGuardrailsMiddleware(GATEWAY);
    const handler = passThrough();
    await plugin.wrapModelCall(makeRequest(makeModel('anthropic'), { humanIds: ['has spaces/and slashes'] }), handler);
    expect(handler.mock.calls[0][0].modelSettings.headers['X-Agent-Turn-Id']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads the user message type from _getType() when there is no type field', async () => {
    const plugin = new LangChainGuardrailsMiddleware(GATEWAY);
    const handler = passThrough();
    const request = makeRequest(makeModel('anthropic'));
    request.state.messages = [{ _getType: () => 'human', id: 'turn-legacy' }];
    await plugin.wrapModelCall(request, handler);
    expect(handler.mock.calls[0][0].modelSettings.headers['X-Agent-Turn-Id']).toBe('turn-legacy');
  });

  it('sends only what it has, and leaves the request untouched when it has neither', async () => {
    const plugin = new LangChainGuardrailsMiddleware(GATEWAY);
    const model = makeModel('anthropic');
    const handler = passThrough();

    await plugin.wrapModelCall(makeRequest(model, { threadId: 'sess-1' }), handler);
    expect(handler.mock.calls[0][0].modelSettings.headers).toEqual({ 'X-Agent-Session-Id': 'sess-1' });

    await plugin.wrapModelCall(makeRequest(model, { humanIds: ['turn-1'] }), handler);
    expect(handler.mock.calls[1][0].modelSettings.headers).toEqual({ 'X-Agent-Turn-Id': 'turn-1' });

    const bare = makeRequest(model);
    await plugin.wrapModelCall(bare, handler);
    expect(handler.mock.calls[2][0]).toBe(bare);
  });

  it('concurrent invocations of one agent each send their own ids', async () => {
    const plugin = new LangChainGuardrailsMiddleware(GATEWAY);
    const model = makeModel('openai');
    const handler = passThrough();

    await Promise.all([
      plugin.wrapModelCall(makeRequest(model, { threadId: 'sess-A', humanIds: ['turn-A'] }), handler),
      plugin.wrapModelCall(makeRequest(model, { threadId: 'sess-B', humanIds: ['turn-B'] }), handler),
    ]);

    const sent = handler.mock.calls.map((c) => c[0].modelSettings.options.headers);
    expect(sent).toEqual([
      { 'X-Agent-Session-Id': 'sess-A', 'X-Agent-Turn-Id': 'turn-A' },
      { 'X-Agent-Session-Id': 'sess-B', 'X-Agent-Turn-Id': 'turn-B' },
    ]);
    expect(model.completions.clientConfig.defaultHeaders['X-Agent-Session-Id']).toBeUndefined();
    expect(model.completions.clientConfig.defaultHeaders['X-Agent-Turn-Id']).toBeUndefined();
  });
});

describe('lifecycle', () => {
  it('uses the config from switchTrust.init() when the constructor had none', async () => {
    switchTrust.init(GATEWAY);
    const plugin = new LangChainGuardrailsMiddleware();
    switchTrust.registerPlugin(plugin);
    const model = makeModel('openai');

    await plugin.wrapModelCall(makeRequest(model), passThrough());

    expect(model.completions.clientConfig.baseURL).toBe('https://gw.example.com/openai');
  });

  it('inherits requireGuardrails from the client', async () => {
    switchTrust.init({ requireGuardrails: false });
    const plugin = new LangChainGuardrailsMiddleware();
    switchTrust.registerPlugin(plugin);
    const request = makeRequest({ unknown: true });
    const handler = passThrough();
    await plugin.wrapModelCall(request, handler);
    expect(handler).toHaveBeenCalledWith(request);
  });

  it('is exported from the package entry point', () => {
    expect(switchTrust.LangChainGuardrailsMiddleware).toBe(LangChainGuardrailsMiddleware);
  });
});
