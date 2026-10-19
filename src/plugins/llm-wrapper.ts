import { type GuardrailsConfig, type Provider, PROVIDER_PATH_MAP, SwitchTrustGuardrailsError } from '../guardrails.js';
import * as core from '../core.js';
import { loadModule, loadModuleVersion } from '../module-loader.js';

export const SUPPORTED_SDK_VERSIONS: Record<string, { pkg: string; min: number[]; maxMajor: number }> = {
  anthropic: { pkg: '@anthropic-ai/sdk', min: [0, 100, 1], maxMajor: 1 },
  openai: { pkg: 'openai', min: [6, 41, 0], maxMajor: 7 },
  google: { pkg: '@google/genai', min: [2, 8, 0], maxMajor: 3 },
};

export function parseVersion(versionStr: string): number[] | null {
  const match = /^(\d+(?:\.\d+)*)/.exec(versionStr);
  if (!match) return null;
  return match[1].split('.').map(Number);
}

export function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

// Pure comparison split out from _checkSdkVersion so the range logic is testable
// without mocking module resolution. Returns a warning string when the installed
// version falls outside the supported range, or null when it's fine / unknowable.
export function _sdkVersionWarning(provider: Provider, version: string): string | null {
  const entry = SUPPORTED_SDK_VERSIONS[provider];
  if (!entry) return null;

  const parts = parseVersion(version);
  if (!parts) return null;

  if (compareVersions(parts, entry.min) < 0 || parts[0] >= entry.maxMajor) {
    const minStr = entry.min.join('.');
    return (
      `${entry.pkg} ${version} is installed but switch-trust-sdk-ts supports ${entry.pkg} >=${minStr},<${entry.maxMajor}. ` +
      'Private API compatibility is not guaranteed.'
    );
  }
  return null;
}

export function _checkSdkVersion(provider: Provider): void {
  const entry = SUPPORTED_SDK_VERSIONS[provider];
  if (!entry) return;

  const version = loadModuleVersion(entry.pkg);
  if (version == null) return;

  const warning = _sdkVersionWarning(provider, version);
  if (warning != null) console.warn(warning);
}

let wrappedClients = new WeakSet<object>();

interface ClientOriginals {
  provider: string;
  originalBaseUrl: unknown;
  originalBaseURLExplicit: unknown;
  headerKeys: Set<string>;
}

const _wrappedClientOriginals = new Map<object, ClientOriginals>();

export function _isWrapped(client: object): boolean {
  return wrappedClients.has(client);
}

export function _markWrapped(client: object): void {
  try {
    wrappedClients.add(client);
  } catch {
    console.warn('Switch Trust SDK: cannot track wrapped client — double-wrapping protection disabled for this client.');
  }
}

// Single source of truth for the Google GenAI transport location. The real
// @google/genai client stores it at `client.apiClient.clientOptions.httpOptions`,
// which is what `getBaseUrl()`/`getHeaders()` read at request time.
function _getGoogleHttpOptions(client: unknown): Record<string, unknown> | null {
  const apiClient = (client as Record<string, unknown>).apiClient;
  if (apiClient == null || typeof apiClient !== 'object') return null;
  const clientOptions = (apiClient as Record<string, unknown>).clientOptions;
  if (clientOptions == null || typeof clientOptions !== 'object') return null;
  const httpOptions = (clientOptions as Record<string, unknown>).httpOptions;
  if (httpOptions == null || typeof httpOptions !== 'object') return null;
  return httpOptions as Record<string, unknown>;
}

function _getSdkHeaders(client: unknown, provider: string): Record<string, string> | null {
  const c = client as Record<string, unknown>;
  if (provider === 'anthropic') {
    const opts = c._options;
    if (opts == null || typeof opts !== 'object') return null;
    const h = (opts as Record<string, unknown>).defaultHeaders;
    return h != null && typeof h === 'object' ? (h as Record<string, string>) : null;
  }
  if (provider === 'openai') {
    const opts = c._options;
    if (opts == null || typeof opts !== 'object') return null;
    const h = (opts as Record<string, unknown>).defaultHeaders;
    return h != null && typeof h === 'object' ? (h as Record<string, string>) : null;
  }
  if (provider === 'google') {
    const httpOptions = _getGoogleHttpOptions(client);
    if (httpOptions == null) return null;
    const headers = httpOptions.headers;
    return headers != null && typeof headers === 'object' ? (headers as Record<string, string>) : null;
  }
  return null;
}

function _getBaseUrl(client: unknown, provider: string): unknown {
  const c = client as Record<string, unknown>;
  if (provider === 'anthropic') {
    return (c as { baseURL?: unknown }).baseURL ?? null;
  }
  if (provider === 'openai') {
    const proto = Object.getPrototypeOf(client) as Record<string, unknown>;
    const descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'baseURL');
    if (descriptor && descriptor.get) {
      return (client as { baseURL: string }).baseURL;
    }
    if ('_base_url' in (client as object)) {
      return c._base_url ?? null;
    }
    if ('baseURL' in (client as object)) {
      return (client as { baseURL?: unknown }).baseURL ?? null;
    }
    return null;
  }
  if (provider === 'google') {
    const httpOptions = _getGoogleHttpOptions(client);
    if (httpOptions != null) {
      return httpOptions.baseUrl ?? null;
    }
  }
  return null;
}

function _saveClientOriginals(client: unknown, provider: string, originalBaseUrl: unknown, originalBaseURLExplicit: unknown, headerKeys: Set<string>): void {
  const obj = client as object;
  const existing = _wrappedClientOriginals.get(obj);
  if (existing) {
    for (const key of headerKeys) {
      existing.headerKeys.add(key);
    }
    return;
  }
  _wrappedClientOriginals.set(obj, { provider, originalBaseUrl, originalBaseURLExplicit, headerKeys });
}

function _restoreClientConfig(client: unknown, provider: string, originalBaseUrl: unknown, originalBaseURLExplicit: unknown, headerKeys: Set<string>): void {
  const c = client as Record<string, unknown>;

  if (provider === 'anthropic') {
    if ('baseURL' in (client as object)) {
      c.baseURL = originalBaseUrl;
      // Restore the SDK's original auth-host adoption behavior; leaving this
      // true would pin the client to the wrap-time baseURL forever.
      c._baseURLIsExplicit = originalBaseURLExplicit;
    }
  } else if (provider === 'openai') {
    const proto = Object.getPrototypeOf(client) as Record<string, unknown>;
    const descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'baseURL');
    if (descriptor && descriptor.set) {
      (client as { baseURL: unknown }).baseURL = originalBaseUrl;
    } else if ('_base_url' in (client as object)) {
      c._base_url = originalBaseUrl;
    } else if ('baseURL' in (client as object)) {
      c.baseURL = originalBaseUrl;
    }
  } else if (provider === 'google') {
    const httpOptions = _getGoogleHttpOptions(client);
    if (httpOptions != null) {
      httpOptions.baseUrl = originalBaseUrl;
    }
  }

  const sdkHeaders = _getSdkHeaders(client, provider);
  if (sdkHeaders != null) {
    for (const key of headerKeys) {
      delete sdkHeaders[key];
    }
  }
}

export function _clearWrapped(): void {
  const failed: object[] = [];
  for (const [client, { provider, originalBaseUrl, originalBaseURLExplicit, headerKeys }] of _wrappedClientOriginals) {
    try {
      _restoreClientConfig(client, provider, originalBaseUrl, originalBaseURLExplicit, headerKeys);
      _wrappedClientOriginals.delete(client);
    } catch {
      // Keep originals + tracking for retry. Never log the error/baseURL/headers
      // — they may carry the gateway host or auth-bearing headers.
      failed.push(client);
      const className = (client as { constructor?: { name?: string } })?.constructor?.name ?? 'unknown';
      console.error(
        `Switch Trust SDK: failed to restore ${provider} client ${className} during shutdown; ` +
          'it may still route through the guardrail gateway. Retained for retry on next shutdown.'
      );
    }
  }
  for (const [model, restore] of _wrappedRestorers) {
    try {
      restore();
      _wrappedRestorers.delete(model);
    } catch {
      // Never log the error itself — may carry the gateway host or auth headers.
      failed.push(model);
      const className = (model as { constructor?: { name?: string } })?.constructor?.name ?? 'unknown';
      console.error(
        `Switch Trust SDK: failed to restore LangChain model ${className} during shutdown; ` +
          'it may still route through the guardrail gateway. Retained for retry on next shutdown.'
      );
    }
  }
  // Successes already removed themselves via .delete() above; whatever remains
  // in either map is exactly the failed set, kept intentionally for retry on next shutdown.
  // Reset all tracking (incl. config-less clients with no originals), then
  // re-track only the failed clients.
  wrappedClients = new WeakSet();
  for (const client of failed) {
    wrappedClients.add(client);
  }
}

const PROVIDER_PREFIXES: Record<string, string[]> = {
  anthropic: ['Anthropic'],
  openai: ['OpenAI'],
  google: ['GoogleGenAI', 'GenAIClient', 'Client'],
};

interface LangChainCheck {
  pkg: string;
  constructorNames: string[];
  provider: Provider;
}

const LANGCHAIN_CHECKS: LangChainCheck[] = [
  {
    pkg: '@langchain/openai',
    constructorNames: ['ChatOpenAI'],
    provider: 'openai',
  },
  {
    pkg: '@langchain/anthropic',
    constructorNames: ['ChatAnthropic'],
    provider: 'anthropic',
  },
  {
    pkg: '@langchain/google-genai',
    constructorNames: ['ChatGoogleGenerativeAI'],
    provider: 'google',
  },
];

function tryInstanceof(client: unknown, pkg: string, exportName: string): boolean {
  try {
    const mod = loadModule(pkg) as Record<string, unknown>;
    const cls = mod[exportName] ?? mod.default;
    if (typeof cls === 'function' && client instanceof cls) return true;
  } catch {
    // package not installed
  }
  return false;
}

function constructorMatch(client: unknown, ...names: string[]): boolean {
  const name = (client as { constructor?: { name?: string } })?.constructor?.name;
  return name != null && names.includes(name);
}

// Detect a LangChain chat model and return [model, provider]. v1.x builds the
// provider client lazily from config on the model, so we config the model itself.
export function _detectLangchainModel(client: unknown): [unknown, Provider] | null {
  for (const check of LANGCHAIN_CHECKS) {
    let isMatch = tryInstanceof(client, check.pkg, check.constructorNames[0]);
    if (!isMatch) {
      isMatch = constructorMatch(client, ...check.constructorNames);
    }
    if (!isMatch) continue;

    return [client, check.provider];
  }
  return null;
}

export function _detectClientType(client: unknown): Provider {
  const className = (client as { constructor?: { name?: string } })?.constructor?.name ?? '';

  if (className.startsWith('Async')) {
    throw new TypeError(`Async clients are not supported: ${className}. Use the sync client instead (e.g. Anthropic, OpenAI, genai.Client).`);
  }

  if (tryInstanceof(client, '@google/adk', 'Agent')) {
    throw new TypeError(
      'ADK agents cannot be wrapped with switchTrust.wrap(). Use ADKGuardrailsPlugin instead:\n' +
        "    import { ADKGuardrailsPlugin } from 'switch-trust-sdk-ts/plugins/adk';\n" +
        '    const plugin = new ADKGuardrailsPlugin({ gatewayUrl: ..., apiKey: ... });\n' +
        '    const agent = new Agent({ model: ..., generateContentConfig: plugin.contentConfig, ' +
        'beforeModelCallback: plugin.beforeModelCallback, ' +
        'onModelErrorCallback: plugin.onModelError });'
    );
  }

  for (const [provider, names] of Object.entries(PROVIDER_PREFIXES)) {
    if (tryInstanceof(client, providerPkg(provider as Provider), names[0])) {
      return provider as Provider;
    }
    if (constructorMatch(client, ...names)) {
      return provider as Provider;
    }
  }

  throw new TypeError(
    `Unrecognized client type: ${
      className || typeof client
    }. Supported: anthropic.Anthropic, openai.OpenAI, google.genai.Client, or LangChain chat models (ChatOpenAI, ChatAnthropic, ChatGoogleGenerativeAI)`
  );
}

function providerPkg(provider: Provider): string {
  switch (provider) {
    case 'anthropic':
      return '@anthropic-ai/sdk';
    case 'openai':
      return 'openai';
    case 'google':
      return '@google/genai';
  }
}

function resolveBaseUrl(provider: Provider, config: GuardrailsConfig): string {
  if (config.provider) {
    return config.baseUrl;
  }
  const pathPrefix = PROVIDER_PATH_MAP[provider];
  return config.gatewayUrl + pathPrefix;
}

// The OpenAI/Anthropic SDKs both read request headers from `_options.defaultHeaders`.
// Anthropic keeps it a plain object; OpenAI normalizes it into a `NullableHeaders`
// ({ values: Headers, nulls: Set }) when OPENAI_CUSTOM_HEADERS is set. Flatten the
// non-plain shapes so callers can merge without silently dropping headers.
//
// A `null` value is meaningful: OpenAI treats a null default header as "suppress the
// SDK's built-in header of that name" (e.g. `Authorization: null` removes the auth
// header derived from the API key). NullableHeaders tracks those in its `nulls` set,
// so we carry them over as explicit nulls — otherwise a deliberately-removed provider
// credential would be silently resurrected when we rebuild defaultHeaders.
function _headersToPlainObject(h: unknown): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if (h == null) return out;
  if (typeof Headers !== 'undefined' && h instanceof Headers) {
    h.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  const obj = h as Record<string, unknown>;
  const values = obj.values;
  if (typeof Headers !== 'undefined' && values instanceof Headers) {
    values.forEach((v, k) => {
      out[k] = v;
    });
    const nulls = obj.nulls;
    if (nulls instanceof Set) {
      for (const k of nulls) out[String(k)] = null;
    }
    return out;
  }
  if (typeof h === 'object') {
    // This branch is only reached for the undefined|Headers|NullableHeaders
    // shapes handled above (plain objects are merged in place, not flattened),
    // so the string filter is defensive — non-string entries aren't expected here.
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' || v === null) out[k] = v as string | null;
    }
  }
  return out;
}

function _isPlainHeaderObject(h: object): boolean {
  if (typeof Headers !== 'undefined' && h instanceof Headers) return false;
  const values = (h as Record<string, unknown>).values;
  if (typeof Headers !== 'undefined' && values instanceof Headers) return false; // NullableHeaders
  return true;
}

function mergeDefaultHeaders(client: unknown, headers: Record<string, string>, requireGuardrails: boolean): void {
  const opts = (client as Record<string, unknown>)._options;
  if (opts == null || typeof opts !== 'object') {
    const className = (client as { constructor?: { name?: string } })?.constructor?.name ?? 'unknown';
    if (requireGuardrails) {
      throw new SwitchTrustGuardrailsError(
        `Cannot set guardrails headers on ${className}: _options not found. ` + 'Traffic would route through the guardrails proxy without authentication.'
      );
    }
    throw new TypeError(
      `Cannot set custom headers on ${className}: _options not found. ` + 'This usually means the SDK version is incompatible — check SUPPORTED_SDK_VERSIONS.'
    );
  }
  const o = opts as Record<string, unknown>;
  const existing = o.defaultHeaders;
  if (existing != null && typeof existing === 'object' && _isPlainHeaderObject(existing)) {
    // Plain object: merge in place, preserving any existing (possibly non-string) entries.
    Object.assign(existing as Record<string, string>, headers);
  } else {
    // undefined | Headers | NullableHeaders: replace with a normalized plain object.
    // _headersToPlainObject preserves null suppressions, so a caller's explicitly
    // removed default header (e.g. Authorization) stays removed. Known limitation:
    // this swaps the container type, and restore only deletes the guardrails keys
    // (see _restoreClientConfig) — it does not rebuild the original
    // Headers/NullableHeaders, so the client keeps a plain object after shutdown().
    o.defaultHeaders = { ..._headersToPlainObject(existing), ...headers };
  }
}

function applyAnthropicConfig(client: unknown, baseUrl: string, headers: Record<string, string>, requireGuardrails: boolean): void {
  const c = client as Record<string, unknown>;
  if (!('baseURL' in (client as object))) {
    const className = (client as { constructor?: { name?: string } })?.constructor?.name ?? 'unknown';
    if (requireGuardrails) {
      throw new SwitchTrustGuardrailsError(
        `Cannot redirect ${className} to the guardrails proxy: baseURL property not found. ` + 'Traffic would not be routed through guardrails.'
      );
    }
    throw new TypeError(`Cannot set baseURL on ${className}: baseURL property not found`);
  }
  // Do the fallible work (header merge) before redirecting baseURL, so a throw
  // never leaves the client pointed at the gateway without its auth header.
  mergeDefaultHeaders(client, headers, requireGuardrails);
  c.baseURL = baseUrl;
  // For credentials/config/profile auth (constructed without an explicit baseURL),
  // the SDK re-adopts its auth-resolved host at request time, which would revert
  // this redirect; mark it explicit so the gateway override sticks. No-op for the
  // common apiKey-only path, where _authState.baseURL is undefined and the guard
  // never fires.
  c._baseURLIsExplicit = true;
}

function applyOpenAIConfig(client: unknown, baseUrl: string, headers: Record<string, string>, requireGuardrails: boolean): void {
  const c = client as Record<string, unknown>;
  const proto = Object.getPrototypeOf(client) as Record<string, unknown>;
  const descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'baseURL');
  const hasSetter = !!(descriptor && descriptor.set);
  const hasUnderscore = '_base_url' in (client as object);
  const hasBaseURL = 'baseURL' in (client as object);
  if (!hasSetter && !hasUnderscore && !hasBaseURL) {
    const className = (client as { constructor?: { name?: string } })?.constructor?.name ?? 'unknown';
    if (requireGuardrails) {
      throw new SwitchTrustGuardrailsError(
        `Cannot redirect ${className} to the guardrails proxy: no writable base URL found. ` + 'Traffic would not be routed through guardrails.'
      );
    }
    throw new TypeError(`Cannot set base_url on ${className}: no known attribute found`);
  }
  // Merge headers before redirecting the base URL, so a throw never leaves the
  // client pointed at the gateway without its auth header.
  mergeDefaultHeaders(client, headers, requireGuardrails);
  if (hasSetter) {
    (client as { baseURL: string }).baseURL = baseUrl;
  } else if (hasUnderscore) {
    c._base_url = baseUrl;
  } else {
    c.baseURL = baseUrl;
  }
}

function applyGoogleConfig(client: unknown, baseUrl: string, headers: Record<string, string>, requireGuardrails: boolean): void {
  const httpOptions = _getGoogleHttpOptions(client);
  if (httpOptions == null) {
    const className = (client as { constructor?: { name?: string } })?.constructor?.name ?? 'unknown';
    if (requireGuardrails) {
      throw new SwitchTrustGuardrailsError(
        `Cannot redirect ${className} to the guardrails proxy: apiClient.clientOptions.httpOptions not found. ` +
          'Traffic would not be routed through guardrails.'
      );
    }
    throw new TypeError(
      `Cannot configure Google client ${className}: apiClient.clientOptions.httpOptions not found. ` +
        'This usually means the SDK version is incompatible — check SUPPORTED_SDK_VERSIONS.'
    );
  }
  // Merge headers before redirecting baseUrl, so a throw never leaves the client
  // pointed at the gateway without its auth header.
  const existing = httpOptions.headers;
  if (existing != null && typeof existing === 'object') {
    Object.assign(existing as Record<string, string>, headers);
  } else {
    httpOptions.headers = { ...headers };
  }
  // Google GenAI joins request paths against baseUrl; keep the trailing slash.
  httpOptions.baseUrl = baseUrl.replace(/\/+$/, '') + '/';
}

const PROVIDER_APPLIERS: Record<string, (client: unknown, baseUrl: string, headers: Record<string, string>, requireGuardrails: boolean) => void> = {
  anthropic: applyAnthropicConfig,
  openai: applyOpenAIConfig,
  google: applyGoogleConfig,
};

function applyGuardrailsConfig(client: unknown, provider: Provider, config: GuardrailsConfig, requireGuardrails: boolean): void {
  const originalBaseUrl = _getBaseUrl(client, provider);
  // Capture before the applier runs — applyAnthropicConfig mutates this flag.
  const originalBaseURLExplicit = (client as Record<string, unknown>)._baseURLIsExplicit;
  const baseUrl = resolveBaseUrl(provider, config);
  const applier = PROVIDER_APPLIERS[provider];
  if (!applier) {
    throw new TypeError(`No guardrails applier for provider: ${JSON.stringify(provider)}`);
  }
  applier(client, baseUrl, config.headers, requireGuardrails);
  _saveClientOriginals(client, provider, originalBaseUrl, originalBaseURLExplicit, new Set(Object.keys(config.headers)));
}

// --- LangChain (v1.x) config application ------------------------------------
// v1.x builds the provider client lazily from config on the model, so we config
// the model's fields. Restore closures are tracked separately from the
// direct-SDK-client machinery (_wrappedClientOriginals) since they revert fields.
const _wrappedRestorers = new Map<object, () => void>();

function _saveRestorer(model: object, restore: () => void): void {
  if (!_wrappedRestorers.has(model)) {
    _wrappedRestorers.set(model, restore);
  }
}

function mergeInto(target: Record<string, string>, headers: Record<string, string>): void {
  Object.assign(target, headers);
}

// Set baseURL + merge headers on a `baseURL`/`defaultHeaders` object; returns a revert closure.
function setBaseUrlAndHeaders(config: Record<string, unknown>, baseUrl: string, headers: Record<string, string>): () => void {
  const originalBaseURL = config.baseURL;
  const existingHeaders = (config.defaultHeaders as Record<string, string> | undefined) ?? {};
  const merged = { ...existingHeaders };
  mergeInto(merged, headers);

  config.baseURL = baseUrl;
  config.defaultHeaders = merged;

  return () => {
    config.baseURL = originalBaseURL;
    const dh = config.defaultHeaders as Record<string, string> | undefined;
    if (dh) for (const k of Object.keys(headers)) delete dh[k];
  };
}

// Config a ChatOpenAI-shaped target: live `clientConfig` (direct invoke) and
// `fields.configuration` (bindTools/withConfig clone via new ChatOpenAI(fields)).
function applyOpenAIClientConfig(
  target: Record<string, unknown> | undefined,
  baseUrl: string,
  headers: Record<string, string>,
  requireGuardrails: boolean
): (() => void) | null {
  if (target == null) return null;
  const restorers: Array<() => void> = [];

  const config = (target.clientConfig ?? (target.clientConfig = {})) as Record<string, unknown>;
  restorers.push(setBaseUrlAndHeaders(config, baseUrl, headers));

  const fields = target.fields as Record<string, unknown> | undefined;
  if (fields != null && typeof fields === 'object') {
    // Clones made from `fields` while wrapped (e.g. via bindTools/withConfig) build their own
    // clientConfig at construction time; restore only reverts this model, not those clones.
    const configuration = (fields.configuration ?? (fields.configuration = {})) as Record<string, unknown>;
    restorers.push(setBaseUrlAndHeaders(configuration, baseUrl, headers));
  }

  // Redirect an already-built client (normally undefined; built lazily on first call).
  if (target.client != null) {
    applyOpenAIConfig(target.client, baseUrl, headers, requireGuardrails);
  }

  return () => {
    for (const restore of restorers) restore();
  };
}

function applyLangchainOpenAI(model: Record<string, unknown>, baseUrl: string, headers: Record<string, string>, requireGuardrails: boolean): void {
  // v1.x ChatOpenAI serves requests via `completions`/`responses` delegates, each
  // with its own clientConfig, so redirect them too — not just the outer model.
  const restorers: Array<() => void> = [];
  for (const target of [model, model.completions as Record<string, unknown> | undefined, model.responses as Record<string, unknown> | undefined]) {
    const restore = applyOpenAIClientConfig(target, baseUrl, headers, requireGuardrails);
    if (restore) restorers.push(restore);
  }
  _saveRestorer(model, () => {
    for (const restore of restorers) restore();
  });
}

function applyLangchainAnthropic(model: Record<string, unknown>, baseUrl: string, headers: Record<string, string>, requireGuardrails: boolean): void {
  const originalApiUrl = model.apiUrl;
  const options = (model.clientOptions ?? (model.clientOptions = {})) as Record<string, unknown>;
  const originalOptionsBaseURL = options.baseURL;
  const existingHeaders = (options.defaultHeaders as Record<string, string> | undefined) ?? {};
  const merged = { ...existingHeaders };
  mergeInto(merged, headers);

  // apiUrl wins over clientOptions.baseURL on build; set both to be safe.
  model.apiUrl = baseUrl;
  options.baseURL = baseUrl;
  options.defaultHeaders = merged;

  // Redirect already-built clients (normally undefined at wrap time).
  for (const key of ['batchClient', 'streamingClient']) {
    if (model[key] != null) applyAnthropicConfig(model[key], baseUrl, headers, requireGuardrails);
  }

  _saveRestorer(model, () => {
    model.apiUrl = originalApiUrl;
    options.baseURL = originalOptionsBaseURL;
    const dh = options.defaultHeaders as Record<string, string> | undefined;
    if (dh) for (const k of Object.keys(headers)) delete dh[k];
  });
}

function applyLangchainGoogle(model: Record<string, unknown>, baseUrl: string, headers: Record<string, string>, requireGuardrails: boolean): void {
  const client = model.client as Record<string, unknown> | undefined;
  if (client == null) {
    const className = (model as { constructor?: { name?: string } })?.constructor?.name ?? 'unknown';
    if (requireGuardrails) {
      throw new SwitchTrustGuardrailsError(
        `Cannot redirect ${className} to the guardrails proxy: client (GenerativeModel) not found. ` + 'Traffic would not be routed through guardrails.'
      );
    }
    throw new TypeError(`Cannot configure LangChain Google model ${className}: client (GenerativeModel) not found.`);
  }
  const requestOptions = (client._requestOptions ?? (client._requestOptions = {})) as Record<string, unknown>;
  const originalBaseUrl = requestOptions.baseUrl;
  const existingHeaders = (requestOptions.customHeaders as Record<string, string> | undefined) ?? {};
  const merged = { ...existingHeaders };
  mergeInto(merged, headers);

  // generative-ai builds `${baseUrl}/${apiVersion}/…`; strip trailing slash.
  requestOptions.baseUrl = baseUrl.replace(/\/+$/, '');
  requestOptions.customHeaders = merged;

  _saveRestorer(model, () => {
    requestOptions.baseUrl = originalBaseUrl;
    const ch = requestOptions.customHeaders as Record<string, string> | undefined;
    if (ch) for (const k of Object.keys(headers)) delete ch[k];
  });
}

const LANGCHAIN_APPLIERS: Record<
  Provider,
  (model: Record<string, unknown>, baseUrl: string, headers: Record<string, string>, requireGuardrails: boolean) => void
> = {
  openai: applyLangchainOpenAI,
  anthropic: applyLangchainAnthropic,
  google: applyLangchainGoogle,
};

export function applyLangchainConfig(model: unknown, provider: Provider, config: GuardrailsConfig, requireGuardrails: boolean): void {
  const baseUrl = resolveBaseUrl(provider, config);
  const applier = LANGCHAIN_APPLIERS[provider];
  if (!applier) {
    throw new TypeError(`No LangChain guardrails applier for provider: ${JSON.stringify(provider)}`);
  }
  applier(model as Record<string, unknown>, baseUrl, config.headers, requireGuardrails);
}

export function wrapClient(client: unknown): unknown {
  const switchTrustClient = core.getClient();

  if (_isWrapped(client as object)) {
    console.warn(
      `Client ${(client as { constructor?: { name?: string } })?.constructor?.name ?? 'unknown'} is already wrapped by Switch Trust SDK — skipping.`
    );
    return client;
  }

  const requireGuardrails = switchTrustClient?.requireGuardrails ?? false;

  const langchainResult = _detectLangchainModel(client);
  if (langchainResult) {
    const [model, provider] = langchainResult;
    _checkSdkVersion(provider);
    if (switchTrustClient?.guardrailsConfig) {
      applyLangchainConfig(model, provider, switchTrustClient.guardrailsConfig, requireGuardrails);
    } else if (requireGuardrails) {
      throw new SwitchTrustGuardrailsError(
        'Guardrails configuration is required but no config was found. ' +
          'Configure guardrails via switchTrust.init() or switchTrust.wrap() before wrapping LLM clients.'
      );
    }
    _markWrapped(client as object);
    return client;
  }

  const provider = _detectClientType(client);
  _checkSdkVersion(provider);
  if (switchTrustClient?.guardrailsConfig) {
    applyGuardrailsConfig(client, provider, switchTrustClient.guardrailsConfig, requireGuardrails);
  } else if (requireGuardrails) {
    throw new SwitchTrustGuardrailsError(
      'Guardrails configuration is required but no config was found. ' +
        'Configure guardrails via switchTrust.init() or switchTrust.wrap() before wrapping LLM clients.'
    );
  }
  _markWrapped(client as object);
  return client;
}
