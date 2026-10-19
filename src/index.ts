import * as core from './core.js';
import { SwitchTrustClient, type GuardrailsStatus } from './core.js';
import { SwitchTrustPlugin } from './plugins/index.js';
import {
  type Provider,
  PROVIDER_PATH_MAP,
  SwitchTrustGuardrailsError,
  resolveFromEnv,
  checkOptionalGuardrailsParams,
  configureGuardrails,
  warnGuardrailsDisabled,
} from './guardrails.js';
import { wrapClient, _clearWrapped } from './plugins/llm-wrapper.js';

export { SwitchTrustClient, type GuardrailsStatus } from './core.js';
export { SwitchTrustPlugin } from './plugins/index.js';
export {
  SwitchTrustGuardrailsError,
  GuardrailsConfig,
  type Provider,
  PROVIDER_PATH_MAP,
  buildGuardrailsConfig,
  configureGuardrails,
  detectProvider,
  resolveFromEnv,
  checkOptionalGuardrailsParams,
} from './guardrails.js';
export { ADKGuardrailsPlugin } from './plugins/adk.js';
export { LangChainGuardrailsMiddleware } from './plugins/langchain.js';

declare const __SWITCH_TRUST_VERSION__: string;
export const VERSION = typeof __SWITCH_TRUST_VERSION__ !== 'undefined' ? __SWITCH_TRUST_VERSION__ : '0.0.0-dev';

let _exitRegistered = false;

function _ensureClient(): void {
  if (!core.getClient()) {
    core.setClient(new SwitchTrustClient());
  }
  if (!_exitRegistered) {
    process.on('beforeExit', () => shutdown());
    _exitRegistered = true;
  }
}

// requireGuardrails and dangerouslyDisableGuardrails must not contradict.
function _resolveRequireGuardrails(opts?: { requireGuardrails?: boolean; dangerouslyDisableGuardrails?: boolean }): boolean {
  if (opts?.dangerouslyDisableGuardrails === true) {
    if (opts.requireGuardrails === true) {
      throw new Error('Conflicting options: dangerouslyDisableGuardrails: true cannot be combined with requireGuardrails: true.');
    }
    return false;
  }
  return opts?.requireGuardrails ?? true;
}

function _configureGuardrailsFromParams(
  gatewayUrl: string | null | undefined,
  apiKey: string | null | undefined,
  policyId: string | null | undefined,
  agentId?: string | null,
  agentName?: string | null,
  allowInsecureGateway = false,
  loadDotenv: boolean | string = false
): void {
  const [gw, ak, pid] = resolveFromEnv(gatewayUrl, apiKey, policyId, loadDotenv);
  if (!checkOptionalGuardrailsParams(gw, ak)) return;
  configureGuardrails(gw!, ak!, undefined, pid, agentId, agentName, allowInsecureGateway);
}

export interface SwitchTrustInitOptions {
  provider?: Provider;
  gatewayUrl?: string;
  apiKey?: string;
  policyId?: string;
  agentName?: string;
  agentId?: string;
  requireGuardrails?: boolean;
  /** Greppable opt-out; same as requireGuardrails: false. Not with requireGuardrails: true. */
  dangerouslyDisableGuardrails?: boolean;
  /**
   * Local development only: permit a loopback gatewayUrl or the
   * SWITCH_TRUST_ALLOWED_GATEWAY_HOSTS='*' wildcard. Cannot be enabled via env/.env.
   */
  allowInsecureGateway?: boolean;
  /**
   * Read a .env file: true loads <cwd>/.env, a string loads that path. Off by
   * default so an untrusted .env cannot influence gateway configuration.
   */
  loadDotenv?: boolean | string;
}

export function init(opts?: SwitchTrustInitOptions): SwitchTrustClient {
  const provider = opts?.provider ?? null;
  const requireGuardrails = _resolveRequireGuardrails(opts);

  if (provider && !Object.prototype.hasOwnProperty.call(PROVIDER_PATH_MAP, provider)) {
    throw new Error(`Unsupported provider: ${JSON.stringify(provider)}. Supported: ${Object.keys(PROVIDER_PATH_MAP).join(', ')}`);
  }

  const existing = core.getClient();
  if (existing) {
    existing.shutdown();
  }

  const client = new SwitchTrustClient(provider, requireGuardrails);
  core.setClient(client);

  if (!_exitRegistered) {
    process.on('beforeExit', () => shutdown());
    _exitRegistered = true;
  }

  const agentId = opts?.agentId ?? process.env.AGENT_ID ?? null;
  const agentName = opts?.agentName ?? process.env.AGENT_NAME ?? null;

  _configureGuardrailsFromParams(
    opts?.gatewayUrl,
    opts?.apiKey,
    opts?.policyId,
    agentId,
    agentName,
    opts?.allowInsecureGateway ?? false,
    opts?.loadDotenv ?? false
  );

  if (requireGuardrails && client.guardrailsConfig == null) {
    throw new SwitchTrustGuardrailsError(
      'Guardrails configuration is required but no config was found. ' +
        'Provide gatewayUrl and apiKey to switchTrust.init(), ' +
        'or set the SWITCH_TRUST_GATEWAY_URL and SWITCH_TRUST_API_KEY environment variables. ' +
        'Pass requireGuardrails: false to allow operation without guardrails.'
    );
  }

  if (!requireGuardrails) {
    warnGuardrailsDisabled('switchTrust.init()', client.guardrailsConfig);
  }

  return client;
}

export function registerPlugin(plugin: SwitchTrustPlugin): void {
  const client = core.getClient();
  if (!client) {
    throw new Error('Call switchTrust.init() before registering plugins');
  }
  client.registerPlugin(plugin);
}

export interface SwitchTrustWrapOptions {
  gatewayUrl?: string;
  apiKey?: string;
  policyId?: string;
  agentName?: string;
  agentId?: string;
  requireGuardrails?: boolean;
  /** Greppable opt-out; same as requireGuardrails: false. Not with requireGuardrails: true. */
  dangerouslyDisableGuardrails?: boolean;
  /**
   * Local development only: permit a loopback gatewayUrl or the
   * SWITCH_TRUST_ALLOWED_GATEWAY_HOSTS='*' wildcard. Cannot be enabled via env/.env.
   */
  allowInsecureGateway?: boolean;
  /**
   * Read a .env file: true loads <cwd>/.env, a string loads that path. Off by
   * default so an untrusted .env cannot influence gateway configuration.
   */
  loadDotenv?: boolean | string;
}

export function wrap<T>(client: T, opts?: SwitchTrustWrapOptions): T {
  _ensureClient();

  const requireGuardrails = _resolveRequireGuardrails(opts);
  const switchTrustClient = core.getClient()!;
  switchTrustClient.requireGuardrails = requireGuardrails;

  const [gatewayUrl, apiKey, policyId] = resolveFromEnv(opts?.gatewayUrl, opts?.apiKey, opts?.policyId, opts?.loadDotenv ?? false);

  const agentId = opts?.agentId ?? process.env.AGENT_ID ?? null;
  const agentName = opts?.agentName ?? process.env.AGENT_NAME ?? null;

  _configureGuardrailsFromParams(gatewayUrl, apiKey, policyId, agentId, agentName, opts?.allowInsecureGateway ?? false, opts?.loadDotenv ?? false);

  if (requireGuardrails && switchTrustClient.guardrailsConfig == null) {
    throw new SwitchTrustGuardrailsError(
      'Guardrails configuration is required but no config was found. ' +
        'Provide gatewayUrl and apiKey to switchTrust.wrap(), ' +
        'or set the SWITCH_TRUST_GATEWAY_URL and SWITCH_TRUST_API_KEY environment variables. ' +
        'Pass requireGuardrails: false to allow operation without guardrails.'
    );
  }

  if (!requireGuardrails) {
    warnGuardrailsDisabled('switchTrust.wrap()', switchTrustClient.guardrailsConfig);
  }

  wrapClient(client);
  return client;
}

// Effective guardrails posture of the current client, or null before init().
export function status(): GuardrailsStatus | null {
  return core.getClient()?.guardrailsStatus() ?? null;
}

export function shutdown(): void {
  const client = core.getClient();
  if (client) {
    client.shutdown();
  }
  core.setClient(null);
  _clearWrapped();
}
