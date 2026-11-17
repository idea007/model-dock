import { openai } from './openai.mjs';
import { ollama } from './ollama.mjs';
import { mflux } from './mflux.mjs';
import { serviceProvider } from './services.mjs';
import { createCodexProvider } from './codex/index.mjs';
export function createProviders(options = {}) {
  return { openai, ollama, mflux, service: serviceProvider, codex: createCodexProvider(options.codex) };
}
