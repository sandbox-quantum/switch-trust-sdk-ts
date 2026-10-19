import type { SwitchTrustClient } from '../core.js';

export abstract class SwitchTrustPlugin {
  name = 'unnamed';

  onInit(_client: SwitchTrustClient): void {}

  onShutdown(): void {}
}
