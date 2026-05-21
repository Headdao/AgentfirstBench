import type { AgentRuntimeAdapter } from './types.js';
import { mockAdapter } from './mock.js';
import { mockCoordinatorAdapter } from './mock-coordinator.js';
import { rawAnthropicAdapter } from './raw-anthropic.js';
import { rawOpenAIAdapter } from './raw-openai.js';
import { rawGoogleAdapter } from './raw-google.js';
import { customHttpAdapter } from './custom-http.js';

const adapters = new Map<string, AgentRuntimeAdapter>();

export function registerAdapter(adapter: AgentRuntimeAdapter): void {
  adapters.set(adapter.name, adapter);
}

export function getAdapter(name: string): AgentRuntimeAdapter | undefined {
  return adapters.get(name);
}

export function listAdapters(): string[] {
  return [...adapters.keys()];
}

// Built-in adapters.
registerAdapter(mockAdapter);
registerAdapter(mockCoordinatorAdapter);
registerAdapter(rawAnthropicAdapter);
registerAdapter(rawOpenAIAdapter);
registerAdapter(rawGoogleAdapter);
registerAdapter(customHttpAdapter);
