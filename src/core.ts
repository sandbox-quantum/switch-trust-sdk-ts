import type { SwitchTrustPlugin } from './plugins/index.js';
import type { GuardrailsConfig, Provider } from './guardrails.js';

export interface GuardrailsStatus {
  /** Traffic is routed through the guardrails gateway (config resolved). */
  active: boolean;
  /** Fail-closed enforcement is on (throws/verifies rather than opting out). */
  requireGuardrails: boolean;
  provider: Provider | null;
  agentId: string | null;
  agentName: string | null;
}

let _client: SwitchTrustClient | null = null;

export function getClient(): SwitchTrustClient | null {
  return _client;
}

export function setClient(c: SwitchTrustClient | null): void {
  _client = c;
}

export class SwitchTrustClient {
  plugins: SwitchTrustPlugin[] = [];
  provider: Provider | null;
  requireGuardrails: boolean;
  guardrailsConfig: GuardrailsConfig | null = null;

  constructor(provider?: Provider | null, requireGuardrails = true) {
    this.provider = provider ?? null;
    this.requireGuardrails = requireGuardrails;
  }

  toString(): string {
    return `SwitchTrustClient(provider=${JSON.stringify(this.provider)}, requireGuardrails=${this.requireGuardrails}, plugins=${this.plugins.length})`;
  }

  guardrailsStatus(): GuardrailsStatus {
    const cfg = this.guardrailsConfig;
    return {
      active: cfg != null,
      requireGuardrails: this.requireGuardrails,
      provider: this.provider,
      agentId: cfg?.agentId ?? null,
      agentName: cfg?.agentName ?? null,
    };
  }

  registerPlugin(plugin: SwitchTrustPlugin): void {
    this.plugins.push(plugin);
    plugin.onInit(this);
  }

  notify(method: string, kwargs?: Record<string, unknown>): void {
    for (const plugin of this.plugins) {
      const handler = (plugin as unknown as Record<string, unknown>)[method];
      if (typeof handler === 'function') {
        try {
          (handler as (...args: unknown[]) => void).call(plugin, kwargs);
        } catch (err) {
          console.warn(`Plugin '${plugin.name}' error in ${method}: ${err}`);
        }
      }
    }
  }

  shutdown(): void {
    this.notify('onShutdown');
    if (this.guardrailsConfig) {
      this.guardrailsConfig.clear();
      this.guardrailsConfig = null;
    }
  }
}
