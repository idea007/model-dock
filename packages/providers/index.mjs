import { openai } from './openai.mjs';
import { ollama } from './ollama.mjs';
import { createCodexProvider } from './codex/index.mjs';
export function createProviders(options = {}) {
  return { openai, ollama, codex: createCodexProvider(options.codex) };
}
