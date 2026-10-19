import type { SwitchTrustClient } from '../core.js';
import {
  type GuardrailsConfig,
  type Provider,
  SwitchTrustGuardrailsError,
  resolveFromEnv,
  checkOptionalGuardrailsParams,
  buildGuardrailsConfig,
} from '../guardrails.js';

export function effectiveRequireGuardrails(value: boolean | null | undefined): boolean {
  return value == null ? true : value;
}

export function validateAndBuildConfig(opts: {
  gatewayUrl?: string | null;
  apiKey?: string | null;
  // Null when the provider is only known later (the LangChain middleware learns it
  // from the agent's model); the base URL is then resolved per provider when routed.
  provider: Provider | null;
  policyId?: string | null;
  agentName?: string | null;
  agentId?: string | null;
  allowInsecureGateway?: boolean;
  loadDotenv?: boolean | string;
}): [GuardrailsConfig | null, boolean] {
  const [gatewayUrl, apiKey, policyId] = resolveFromEnv(opts.gatewayUrl, opts.apiKey, opts.policyId, opts.loadDotenv ?? false);

  if (!checkOptionalGuardrailsParams(gatewayUrl, apiKey)) {
    return [null, false];
  }

  const agentId = opts.agentId ?? process.env.AGENT_ID ?? null;
  const agentName = opts.agentName ?? process.env.AGENT_NAME ?? null;

  const config = buildGuardrailsConfig(gatewayUrl!, apiKey!, opts.provider, policyId, agentId, agentName, opts.allowInsecureGateway ?? false);

  return [config, true];
}

export function resolveOnInit(
  client: SwitchTrustClient,
  config: GuardrailsConfig | null,
  configFromConstructor: boolean,
  requireGuardrails = true
): GuardrailsConfig | null {
  if (configFromConstructor && config) {
    client.guardrailsConfig = config;
    console.info(`LLM traffic will route through: ${config.baseUrl}`);
    return config;
  }

  const resolved = client.guardrailsConfig;
  if (!resolved) {
    if (requireGuardrails) {
      throw new SwitchTrustGuardrailsError('No guardrails config found. Pass gatewayUrl and apiKey to switchTrust.init() or the plugin constructor.');
    }
    console.warn('No guardrails config found. Pass gatewayUrl and apiKey to init() or the plugin constructor.');
    return null;
  }
  console.info(`LLM traffic will route through: ${resolved.baseUrl}`);
  return resolved;
}
