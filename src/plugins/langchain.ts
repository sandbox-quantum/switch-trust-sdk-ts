import { createHash } from 'node:crypto';
import { SwitchTrustPlugin } from './index.js';
import { validateAndBuildConfig, resolveOnInit, effectiveRequireGuardrails } from './provider-base.js';
import { _checkSdkVersion, _detectLangchainModel, _isWrapped, _markWrapped, applyLangchainConfig } from './llm-wrapper.js';
import type { SwitchTrustClient } from '../core.js';
import { SwitchTrustGuardrailsError, warnGuardrailsDisabled, type GuardrailsConfig, type Provider } from '../guardrails.js';

// createAgent recognizes middleware by this global-registry symbol, which is all
// langchain's createMiddleware() adds. Building the object here keeps `langchain`
// out of the SDK's imports (peers are never imported statically).
const MIDDLEWARE_BRAND = Symbol.for('AgentMiddleware');

// The guardrails proxy drops turn ids outside this shape, so anything else is hashed.
const TURN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

type Handler = (request: ModelRequestLike) => unknown;

interface ModelRequestLike {
  model?: unknown;
  messages?: unknown[];
  state?: { messages?: unknown[] } & Record<string, unknown>;
  runtime?: { configurable?: { thread_id?: unknown } & Record<string, unknown> } & Record<string, unknown>;
  modelSettings?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Routes a LangChain agent's model calls through the Switch Trust guardrails proxy
 * and tags each call with X-Agent-Id / X-Agent-Name (AGENT_ID / AGENT_NAME),
 * X-Agent-Session-Id (the invocation's `thread_id`) and X-Agent-Turn-Id (shared by
 * every model call of one `agent.invoke`, tool loop included).
 *
 * ```ts
 * const plugin = new LangChainGuardrailsMiddleware();
 * const agent = createAgent({ model: new ChatOpenAI({ model: 'gpt-4o' }), tools, middleware: [plugin.middleware] });
 * await agent.invoke({ messages: [...] }, { configurable: { thread_id: 'session-123' } });
 * ```
 */
export class LangChainGuardrailsMiddleware extends SwitchTrustPlugin {
  override name = 'langchain-guardrails';

  /**
   * Pass this to `createAgent({ middleware: [...] })`. Typed `any` because the SDK
   * can't name langchain's AgentMiddleware type without importing the peer; any
   * narrower type would force every caller to cast.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly middleware: any;

  private _config: GuardrailsConfig | null;
  private _configFromConstructor: boolean;
  private _requireGuardrails: boolean | null;

  constructor(opts?: {
    gatewayUrl?: string | null;
    apiKey?: string | null;
    policyId?: string | null;
    agentName?: string | null;
    agentId?: string | null;
    requireGuardrails?: boolean | null;
    /** Greppable opt-out; same as requireGuardrails: false. Not with requireGuardrails: true. */
    dangerouslyDisableGuardrails?: boolean;
    allowInsecureGateway?: boolean;
    loadDotenv?: boolean | string;
  }) {
    super();
    if (opts?.dangerouslyDisableGuardrails === true) {
      if (opts.requireGuardrails === true) {
        throw new Error('Conflicting options: dangerouslyDisableGuardrails: true cannot be combined with requireGuardrails: true.');
      }
      this._requireGuardrails = false;
    } else {
      this._requireGuardrails = opts?.requireGuardrails ?? null;
    }

    const [config, fromConstructor] = validateAndBuildConfig({
      gatewayUrl: opts?.gatewayUrl,
      apiKey: opts?.apiKey,
      provider: null,
      policyId: opts?.policyId,
      agentName: opts?.agentName,
      agentId: opts?.agentId,
      allowInsecureGateway: opts?.allowInsecureGateway,
      loadDotenv: opts?.loadDotenv,
    });
    this._config = config;
    this._configFromConstructor = fromConstructor;

    this.middleware = {
      [MIDDLEWARE_BRAND]: true,
      name: this.name,
      wrapModelCall: (request: ModelRequestLike, handler: Handler) => this.wrapModelCall(request, handler),
    };
  }

  override onInit(client: SwitchTrustClient): void {
    if (this._requireGuardrails == null) {
      this._requireGuardrails = client.requireGuardrails;
    }
    this._config = resolveOnInit(client, this._config, this._configFromConstructor, this._requireGuardrails ?? true);
    if (!effectiveRequireGuardrails(this._requireGuardrails)) {
      warnGuardrailsDisabled('LangChainGuardrailsMiddleware', this._config);
    }
  }

  async wrapModelCall(request: ModelRequestLike, handler: Handler): Promise<unknown> {
    const requireGuardrails = effectiveRequireGuardrails(this._requireGuardrails);

    let model = request.model;
    let detected = _detectLangchainModel(model);
    // A model given to createAgent as a string ("openai:gpt-4o") arrives as a
    // ConfigurableModel; route the provider model it caches instead.
    const getInstance = (model as { _getModelInstance?: unknown } | null)?._getModelInstance;
    if (!detected && typeof getInstance === 'function') {
      model = await (getInstance as () => Promise<unknown>).call(request.model);
      detected = _detectLangchainModel(model);
      if (detected) request = { ...request, model };
    }

    if (!detected) {
      const className = (request.model as { constructor?: { name?: string } } | null)?.constructor?.name ?? typeof request.model;
      if (requireGuardrails) {
        throw new SwitchTrustGuardrailsError(
          `Cannot route ${className} through the guardrails proxy: not a supported LangChain chat model ` +
            '(ChatOpenAI, ChatAnthropic, ChatGoogleGenerativeAI).'
        );
      }
      return handler(request);
    }

    const [, provider] = detected;
    if (!this._route(model as object, provider, requireGuardrails)) {
      return handler(request);
    }

    const headers = perCallHeaders(request);
    return handler(Object.keys(headers).length > 0 ? withRequestHeaders(request, model, provider, headers) : request);
  }

  // Routes the model through the proxy once (agent id/name ride on the routed
  // client's static headers). Returns false when there is no config to route with.
  private _route(model: object, provider: Provider, requireGuardrails: boolean): boolean {
    if (_isWrapped(model)) return true;
    if (!this._config) {
      if (requireGuardrails) {
        throw new SwitchTrustGuardrailsError(
          'Guardrails configuration is required but no config was found. ' +
            'Pass gatewayUrl and apiKey to the middleware constructor or to switchTrust.init().'
        );
      }
      console.warn('switch-trust-sdk-ts: no guardrails config found; LangChain model calls are not routed through the guardrails proxy.');
      return false;
    }
    _checkSdkVersion(provider);
    applyLangchainConfig(model, provider, this._config, requireGuardrails);
    _markWrapped(model);
    return true;
  }
}

// Session and turn ids for this model call only. They never go on the shared
// client: concurrent invocations of one agent share it, so they would mix up.
function perCallHeaders(request: ModelRequestLike): Record<string, string> {
  const headers: Record<string, string> = {};
  const threadId = request.runtime?.configurable?.thread_id;
  if (typeof threadId === 'string' && threadId) {
    headers['X-Agent-Session-Id'] = threadId;
  }
  const turnId = turnIdFor(request);
  if (turnId) {
    headers['X-Agent-Turn-Id'] = turnId;
  }
  return headers;
}

// The turn is the latest user message: every model call of one agent.invoke (tool
// loop included) sees the same one, and each new user message starts a new turn.
// LangGraph's messages reducer gives every message an id, so its id is the turn id.
function turnIdFor(request: ModelRequestLike): string | null {
  const messages = request.state?.messages ?? request.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { type?: unknown; _getType?: () => unknown; id?: unknown } | null;
    const type = message?.type ?? message?._getType?.();
    if (type !== 'human') continue;
    const id = message?.id;
    if (typeof id !== 'string' || !id) return null;
    return TURN_ID_PATTERN.test(id) ? id : createHash('sha256').update(id).digest('hex');
  }
  return null;
}

// Each provider class takes per-call headers differently: ChatOpenAI via its
// `options` request options, ChatAnthropic via `headers`, and ChatGoogleGenerativeAI
// not at all (it passes only an abort signal per call), so Google gets a per-call
// shallow clone of the model whose client carries the extra headers.
function withRequestHeaders(request: ModelRequestLike, model: unknown, provider: Provider, headers: Record<string, string>): ModelRequestLike {
  if (provider === 'google') {
    return { ...request, model: withGoogleClientHeaders(model, headers) };
  }
  const settings = { ...(request.modelSettings ?? {}) };
  if (provider === 'openai') {
    const options = (settings.options as Record<string, unknown> | undefined) ?? {};
    settings.options = { ...options, headers: { ...((options.headers as Record<string, string> | undefined) ?? {}), ...headers } };
  } else {
    settings.headers = { ...((settings.headers as Record<string, string> | undefined) ?? {}), ...headers };
  }
  return { ...request, modelSettings: settings };
}

function withGoogleClientHeaders(model: unknown, headers: Record<string, string>): unknown {
  const source = model as { client?: Record<string, unknown> };
  const client = source.client;
  if (client == null) {
    throw new SwitchTrustGuardrailsError('Cannot attach session headers to ChatGoogleGenerativeAI: client (GenerativeModel) not found.');
  }
  const requestOptions = (client._requestOptions as Record<string, unknown> | undefined) ?? {};
  const clientClone = Object.assign(Object.create(Object.getPrototypeOf(client)), client, {
    _requestOptions: {
      ...requestOptions,
      customHeaders: { ...((requestOptions.customHeaders as Record<string, string> | undefined) ?? {}), ...headers },
    },
  });
  const modelClone = Object.create(model as object) as { client?: unknown };
  modelClone.client = clientClone;
  return modelClone;
}
