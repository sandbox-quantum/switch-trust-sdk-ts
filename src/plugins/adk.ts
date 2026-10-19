import { SwitchTrustPlugin } from './index.js';
import { validateAndBuildConfig, resolveOnInit, effectiveRequireGuardrails } from './provider-base.js';
import { loadModule } from '../module-loader.js';
import type { SwitchTrustClient } from '../core.js';
import { SwitchTrustGuardrailsError, warnGuardrailsDisabled, type GuardrailsConfig } from '../guardrails.js';

export class ADKGuardrailsPlugin extends SwitchTrustPlugin {
  override name = 'adk-guardrails';
  private static readonly _PROVIDER = 'google' as const;
  private static readonly _GUARDRAIL_BLOCKED_CODE = 'GUARDRAIL_BLOCKED';
  private static readonly _API_KEY_HEADER = 'X-FlintAI-API-Key';

  private _userContentConfig: unknown;
  contentConfig: unknown = null;
  private _config: GuardrailsConfig | null;
  private _configFromConstructor: boolean;
  private _requireGuardrails: boolean | null;
  // Base headers snapshotted at build time; each request rebuilds from these.
  private _baseHeaders: Record<string, string> | null = null;

  constructor(opts?: {
    gatewayUrl?: string | null;
    apiKey?: string | null;
    policyId?: string | null;
    contentConfig?: unknown;
    agentName?: string | null;
    agentId?: string | null;
    requireGuardrails?: boolean | null;
    /** Greppable opt-out; same as requireGuardrails: false. Not with requireGuardrails: true. */
    dangerouslyDisableGuardrails?: boolean;
    allowInsecureGateway?: boolean;
    loadDotenv?: boolean | string;
  }) {
    super();
    this.beforeModelCallback = this.beforeModelCallback.bind(this);
    this._userContentConfig = opts?.contentConfig ?? null;
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
      provider: ADKGuardrailsPlugin._PROVIDER,
      policyId: opts?.policyId,
      agentName: opts?.agentName,
      agentId: opts?.agentId,
      allowInsecureGateway: opts?.allowInsecureGateway,
      loadDotenv: opts?.loadDotenv,
    });

    this._config = config;
    this._configFromConstructor = fromConstructor;

    if (this._config) {
      this._buildContentConfig(this._config);
    }
  }

  private _assignContentConfig(httpOptions: unknown, ConfigClass?: new (opts: unknown) => unknown): void {
    if (this._userContentConfig) {
      // Clone so a config reused across agents/sessions isn't mutated.
      const src = this._userContentConfig as Record<string, unknown>;
      const clone = Object.assign(Object.create(Object.getPrototypeOf(src)), src) as Record<string, unknown>;
      clone.httpOptions = httpOptions;
      this.contentConfig = clone;
    } else {
      this.contentConfig = ConfigClass ? new ConfigClass({ httpOptions }) : { httpOptions };
    }
  }

  private _buildContentConfig(config: GuardrailsConfig): void {
    this._baseHeaders = { ...config.headers };
    const httpBase = { baseUrl: config.baseUrl.replace(/\/+$/, '') + '/', headers: { ...config.headers } };

    let GenerateContentConfig: new (opts: unknown) => unknown;
    let HttpOptions: new (opts: unknown) => unknown;
    try {
      const genai = loadModule('@google/genai') as Record<string, unknown>;
      const types = genai.types as Record<string, unknown> | undefined;
      GenerateContentConfig = (types?.GenerateContentConfig ?? genai.GenerateContentConfig) as typeof GenerateContentConfig;
      HttpOptions = (types?.HttpOptions ?? genai.HttpOptions) as typeof HttpOptions;
    } catch {
      console.warn('switch-trust-sdk-ts: @google/genai not found, using plain object for content config');
      this._assignContentConfig(httpBase);
      return;
    }

    if (typeof HttpOptions !== 'function' || typeof GenerateContentConfig !== 'function') {
      this._assignContentConfig(httpBase);
      return;
    }
    this._assignContentConfig(new HttpOptions(httpBase), GenerateContentConfig);
  }

  override onInit(client: SwitchTrustClient): void {
    if (this._requireGuardrails == null) {
      this._requireGuardrails = client.requireGuardrails;
    }
    const resolved = resolveOnInit(client, this._config, this._configFromConstructor, this._requireGuardrails ?? true);
    this._config = resolved;
    if (!effectiveRequireGuardrails(this._requireGuardrails)) {
      warnGuardrailsDisabled('ADKGuardrailsPlugin', this._config);
    }
    if (this._config && this.contentConfig == null) {
      this._buildContentConfig(this._config);
    }
  }

  beforeModelCallback({ context, request }: { context?: unknown; request?: unknown }): null {
    // @google/adk invokes agent callbacks with a single { context, request } object.
    const callbackContext = context;
    const llmRequest = request;
    if (effectiveRequireGuardrails(this._requireGuardrails) && ADKGuardrailsPlugin._usesInteractionsApi(callbackContext)) {
      throw new SwitchTrustGuardrailsError(
        'Guardrails are required but the agent model uses the Gemini Interactions API (useInteractionsApi), which ignores httpOptions, ' +
          'so its requests cannot be routed through the Switch Trust gateway.'
      );
    }
    const req = llmRequest as { config?: Record<string, unknown> | null };
    const config = req?.config;
    if (config == null) {
      if (effectiveRequireGuardrails(this._requireGuardrails)) {
        throw new SwitchTrustGuardrailsError('Guardrails are required but the LLM request has no config. Ensure the request includes a config object.');
      }
      return null;
    }

    if (config.http_options != null && effectiveRequireGuardrails(this._requireGuardrails)) {
      throw new SwitchTrustGuardrailsError(
        'Guardrails are required but the LLM request config sets http_options, which @google/genai ignores. ' +
          "Use httpOptions, or pass the plugin's contentConfig as the agent's generateContentConfig."
      );
    }

    const httpOptionsKey = config.http_options != null ? 'http_options' : 'httpOptions';
    const httpOptions = config[httpOptionsKey] as Record<string, unknown> | null | undefined;
    if (httpOptions == null) {
      if (effectiveRequireGuardrails(this._requireGuardrails)) {
        throw new SwitchTrustGuardrailsError(
          'Guardrails are required but the LLM request has no httpOptions. ' + "Pass the plugin's contentConfig as the agent's generateContentConfig."
        );
      }
      return null;
    }

    let validatedBaseUrl: string | undefined;
    if (effectiveRequireGuardrails(this._requireGuardrails) && this._config) {
      const normalize = (url: string): string => url.replace(/\/+$/, '');
      const expectedBaseUrl = normalize(this._config.baseUrl);
      const requestBaseUrl = httpOptions.baseUrl;
      validatedBaseUrl = typeof requestBaseUrl === 'string' ? requestBaseUrl : undefined;
      if (validatedBaseUrl === undefined || normalize(validatedBaseUrl) !== expectedBaseUrl) {
        throw new SwitchTrustGuardrailsError(
          `Guardrails are required but the LLM request httpOptions.baseUrl does not match the configured Switch Trust gateway. ` +
            `Expected "${expectedBaseUrl}". Route the request through the plugin's contentConfig instead of a direct provider configuration.`
        );
      }

      const expectedApiKey = this._config.headers[ADKGuardrailsPlugin._API_KEY_HEADER];
      const requestHeaders = httpOptions.headers && typeof httpOptions.headers === 'object' ? (httpOptions.headers as Record<string, unknown>) : {};
      if (!expectedApiKey || requestHeaders[ADKGuardrailsPlugin._API_KEY_HEADER] !== expectedApiKey) {
        throw new SwitchTrustGuardrailsError(
          `Guardrails are required but the LLM request is missing a valid ${ADKGuardrailsPlugin._API_KEY_HEADER} header ` +
            `matching the configured gateway credentials.`
        );
      }
    }

    // Rebuild from the snapshot so prior-turn identity can't leak in; fall back
    // to request headers only when there is no config.
    const base = this._baseHeaders ?? (httpOptions.headers && typeof httpOptions.headers === 'object' ? (httpOptions.headers as Record<string, string>) : {});
    const headers: Record<string, string> = { ...base };

    if (!('X-Agent-Id' in headers)) {
      const envAgentId = process.env.AGENT_ID;
      if (envAgentId) {
        headers['X-Agent-Id'] = envAgentId;
      }
    }

    if (!('X-Agent-Name' in headers)) {
      const envAgentName = process.env.AGENT_NAME;
      if (envAgentName) {
        headers['X-Agent-Name'] = envAgentName;
      } else {
        let agentName: string | undefined;
        try {
          agentName = (callbackContext as { agent_name?: string })?.agent_name ?? (callbackContext as { agentName?: string })?.agentName;
        } catch {
          // no agent name available
        }
        if (agentName) {
          headers['X-Agent-Name'] = agentName;
        }
      }
    }

    // Set the session id if present; the snapshot handles the no-session case.
    // @google/adk's callback context exposes it as `sessionId`; `session.id` is
    // the Python ADK shape, kept as a fallback.
    try {
      const ctx = callbackContext as { sessionId?: unknown; session?: { id?: unknown } } | undefined;
      const sessionId = typeof ctx?.sessionId === 'string' && ctx.sessionId ? ctx.sessionId : ctx?.session?.id;
      if (typeof sessionId === 'string' && sessionId) {
        headers['X-Agent-Session-Id'] = sessionId;
      }
    } catch {
      // no session available
    }

    // The invocation id is one per user message and shared by every model and
    // tool step of it, so it correlates all LLM calls of a turn.
    try {
      const turnId = (callbackContext as { invocationId?: unknown })?.invocationId;
      if (typeof turnId === 'string' && turnId) {
        headers['X-Agent-Turn-Id'] = turnId;
      }
    } catch {
      // no invocation id available
    }

    // Assign a fresh httpOptions to the per-request config; mutating the shared
    // one would leak session/identity across interleaved turns. Keep prototype.
    const requestHttpOptions = Object.assign(Object.create(Object.getPrototypeOf(httpOptions)), httpOptions) as Record<string, unknown>;
    requestHttpOptions.headers = headers;
    if (validatedBaseUrl !== undefined) {
      requestHttpOptions.baseUrl = validatedBaseUrl;
    }
    config[httpOptionsKey] = requestHttpOptions;

    return null;
  }

  private static _usesInteractionsApi(context: unknown): boolean {
    try {
      const agent = (context as { invocationContext?: { agent?: { canonicalModel?: unknown } } } | undefined)?.invocationContext?.agent;
      return (agent?.canonicalModel as { useInteractionsApi?: unknown } | undefined)?.useInteractionsApi === true;
    } catch {
      return false;
    }
  }

  private static _detectGuardrailBlock(error: Error): Record<string, unknown> | null {
    for (const attr of ['error', 'body'] as const) {
      const data = (error as unknown as Record<string, unknown>)[attr];
      if (data != null && typeof data === 'object' && (data as Record<string, unknown>).code === ADKGuardrailsPlugin._GUARDRAIL_BLOCKED_CODE) {
        ADKGuardrailsPlugin._validateBlockPayload(data as Record<string, unknown>);
        return data as Record<string, unknown>;
      }
    }
    return null;
  }

  // Strict shape check stands in for a versioned contract: required fields validated, unknown keys tolerated.
  private static _validateBlockPayload(data: Record<string, unknown>): void {
    const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
    const fail = (detail: string): never => {
      throw new SwitchTrustGuardrailsError(`Guardrail block payload from gateway is malformed: ${detail}`);
    };

    if (!nonEmptyString(data.policy_id)) {
      fail('policy_id must be a non-empty string');
    }
    if (!nonEmptyString(data.policy_name)) {
      fail('policy_name must be a non-empty string');
    }
    if (!Array.isArray(data.findings)) {
      fail('findings must be an array');
    }
    for (const finding of data.findings as unknown[]) {
      if (finding == null || typeof finding !== 'object') {
        fail('each finding must be an object');
      }
      const f = finding as Record<string, unknown>;
      for (const key of ['category', 'severity', 'message'] as const) {
        if (typeof f[key] !== 'string') {
          fail(`finding.${key} must be a string`);
        }
      }
    }
  }

  static onModelError(_callbackContext: unknown, _llmRequest: unknown, error: Error & { status_code?: number; code?: number; statusCode?: number }): unknown {
    let LlmResponse: new (opts: unknown) => unknown;
    let types: Record<string, unknown>;
    try {
      const adk = loadModule('@google/adk') as Record<string, unknown>;
      const models = adk.models as Record<string, unknown> | undefined;
      LlmResponse = (models?.LlmResponse ??
        ((adk.models as Record<string, unknown>)?.llm_response as Record<string, unknown>)?.LlmResponse) as typeof LlmResponse;
      const genai = loadModule('@google/genai') as Record<string, unknown>;
      types = (genai.types ?? genai) as Record<string, unknown>;
    } catch {
      throw new Error('google-adk and google-genai are required for on_model_error. Install with: npm install @google/adk @google/genai');
    }

    const blockData = ADKGuardrailsPlugin._detectGuardrailBlock(error);

    if (blockData !== null) {
      console.warn(`Request blocked: ${error}`);
      const Content = types.Content as (new (opts: unknown) => unknown) | undefined;
      const Part = types.Part as (new (opts: unknown) => unknown) | undefined;

      const part = Part ? new Part({ text: 'Request blocked by guardrails policy.' }) : { text: 'Request blocked by guardrails policy.' };
      const content = Content ? new Content({ role: 'model', parts: [part] }) : { role: 'model', parts: [part] };

      let customMetadata: Record<string, unknown> | undefined;
      if (Object.keys(blockData).length > 0) {
        customMetadata = {};
        for (const key of ['policy_id', 'policy_name', 'findings'] as const) {
          if (key in blockData) {
            customMetadata[key] = blockData[key];
          }
        }
        if (Object.keys(customMetadata).length === 0) {
          customMetadata = undefined;
        }
      }

      const responseOpts = {
        content,
        error_code: ADKGuardrailsPlugin._GUARDRAIL_BLOCKED_CODE,
        error_message: String(error),
        turn_complete: true,
        custom_metadata: customMetadata,
      };
      return typeof LlmResponse === 'function' ? new LlmResponse(responseOpts) : responseOpts;
    }

    throw error;
  }
}
