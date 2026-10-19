import { describe, it, expect, vi } from 'vitest';
import { SwitchTrustClient, getClient, setClient } from '../src/core.js';
import { SwitchTrustPlugin } from '../src/plugins/index.js';
import { GuardrailsConfig } from '../src/guardrails.js';

describe('SwitchTrustClient', () => {
  it('defaults to empty plugins, null provider, null config, requireGuardrails true', () => {
    const client = new SwitchTrustClient();
    expect(client.plugins).toEqual([]);
    expect(client.provider).toBeNull();
    expect(client.guardrailsConfig).toBeNull();
    expect(client.requireGuardrails).toBe(true);
  });

  it('constructs with provider', () => {
    const client = new SwitchTrustClient('openai');
    expect(client.provider).toBe('openai');
  });

  it('constructs with requireGuardrails false', () => {
    const client = new SwitchTrustClient('openai', false);
    expect(client.requireGuardrails).toBe(false);
  });

  it('registerPlugin calls onInit and appends', () => {
    const client = new SwitchTrustClient();

    class PluginA extends SwitchTrustPlugin {
      name = 'plugin-a';
      onInit = vi.fn();
    }
    class PluginB extends SwitchTrustPlugin {
      name = 'plugin-b';
      onInit = vi.fn();
    }

    const pluginA = new PluginA();
    const pluginB = new PluginB();

    client.registerPlugin(pluginA);
    expect(pluginA.onInit).toHaveBeenCalledOnce();
    expect(pluginA.onInit).toHaveBeenCalledWith(client);

    client.registerPlugin(pluginB);
    expect(pluginB.onInit).toHaveBeenCalledOnce();
    expect(client.plugins).toHaveLength(2);
  });

  it('notify calls handler only on plugins that have it', () => {
    const client = new SwitchTrustClient();

    class PluginWithShutdown extends SwitchTrustPlugin {
      name = 'with-shutdown';
      onShutdown = vi.fn();
    }
    class PluginWithoutShutdown extends SwitchTrustPlugin {
      name = 'without-shutdown';
    }

    const pluginWith = new PluginWithShutdown();
    const pluginWithout = new PluginWithoutShutdown();
    // bypass onInit by setting directly
    client.plugins = [pluginWith, pluginWithout];

    client.notify('onShutdown');

    expect(pluginWith.onShutdown).toHaveBeenCalledOnce();
  });

  it('notify catches plugin errors and logs warning', () => {
    const warnSpy = vi.spyOn(console, 'warn');
    const client = new SwitchTrustClient();

    class FailingPlugin extends SwitchTrustPlugin {
      name = 'failing';
      onShutdown(): void {
        throw new Error('plugin error');
      }
    }
    class OkPlugin extends SwitchTrustPlugin {
      name = 'ok';
      onShutdown = vi.fn();
    }

    const failing = new FailingPlugin();
    const ok = new OkPlugin();
    client.plugins = [failing, ok];

    client.notify('onShutdown');

    expect(ok.onShutdown).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toMatch(/plugin error/);
  });

  it('shutdown notifies plugins and clears guardrailsConfig', () => {
    const client = new SwitchTrustClient();

    class MockPlugin extends SwitchTrustPlugin {
      name = 'mock';
      onShutdown = vi.fn();
    }

    const plugin = new MockPlugin();
    client.plugins = [plugin];
    client.guardrailsConfig = new GuardrailsConfig({
      baseUrl: 'https://gw.example.com/openai',
      headers: { 'X-FlintAI-API-Key': 'test' },
      provider: 'openai',
      gatewayUrl: 'https://gw.example.com',
    });

    client.shutdown();

    expect(plugin.onShutdown).toHaveBeenCalledOnce();
    expect(client.guardrailsConfig).toBeNull();
  });

  it('toString includes provider, requireGuardrails, and plugin count', () => {
    const client = new SwitchTrustClient('openai');

    class MockPlugin extends SwitchTrustPlugin {
      name = 'mock';
    }
    client.plugins = [new MockPlugin()];

    const str = client.toString();
    expect(str).toContain('openai');
    expect(str).toContain('requireGuardrails=true');
    expect(str).toContain('1');
  });

  it('base plugin methods are no-ops', () => {
    class NoopPlugin extends SwitchTrustPlugin {
      name = 'noop';
    }

    const plugin = new NoopPlugin();
    const client = new SwitchTrustClient();

    expect(() => plugin.onInit(client)).not.toThrow();
    expect(() => plugin.onShutdown()).not.toThrow();
  });

  it('notify skips plugins without the named method', () => {
    const client = new SwitchTrustClient();
    class MyPlugin extends SwitchTrustPlugin {
      name = 'my';
    }
    client.plugins = [new MyPlugin()];
    expect(() => client.notify('nonExistentMethod')).not.toThrow();
  });

  it('notify passes kwargs to handler', () => {
    const client = new SwitchTrustClient();
    const handler = vi.fn();

    class KwargsPlugin extends SwitchTrustPlugin {
      name = 'kwargs';
      customMethod = handler;
    }
    client.plugins = [new KwargsPlugin()];

    client.notify('customMethod', { key: 'value' });
    expect(handler).toHaveBeenCalledWith({ key: 'value' });
  });

  it('shutdown is safe when guardrailsConfig is already null', () => {
    const client = new SwitchTrustClient();
    expect(client.guardrailsConfig).toBeNull();
    expect(() => client.shutdown()).not.toThrow();
  });
});

describe('getClient / setClient', () => {
  it('stores, retrieves, and clears client', () => {
    setClient(null);
    expect(getClient()).toBeNull();

    const client = new SwitchTrustClient();
    setClient(client);
    expect(getClient()).toBe(client);

    setClient(null);
    expect(getClient()).toBeNull();
  });
});
