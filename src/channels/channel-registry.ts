/**
 * STUB — local copy for standalone typecheck/tests in this port repo.
 *
 * Real implementation lives in upstream nanoclaw at
 * `src/channels/channel-registry.ts`. This file is NOT installed by the
 * /add-discord skill; only `discord.ts` is. Tests vi.mock this module so
 * `registerChannelAdapter` calls are observable.
 */
import type { ChannelAdapter, ChannelRegistration } from './adapter.js';

const registry = new Map<string, ChannelRegistration>();

export function registerChannelAdapter(name: string, registration: ChannelRegistration): void {
  registry.set(name, registration);
}

export function getRegistry(): Map<string, ChannelRegistration> {
  return registry;
}

export function getChannelAdapter(_channelType: string): ChannelAdapter | undefined {
  return undefined;
}

export function clearRegistry(): void {
  registry.clear();
}
