import { lstatSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const registry = JSON.parse(readFileSync(new URL('./models.json', import.meta.url), 'utf8'));

function filesReady(root, files) {
  try {
    return Object.entries(files).every(([name, size]) => {
      const stat = statSync(path.join(root, name));
      return stat.isFile() && stat.size === size;
    });
  } catch { return false; }
}

export function modelReady(modelsRoot, modelId) {
  if (!Object.hasOwn(registry.models, modelId)) return false;
  const model = registry.models[modelId];
  return filesReady(path.join(modelsRoot, model.directory), model.requiredFiles) && (model.bundledTextEncoder ||
    filesReady(path.join(modelsRoot, registry.gemma.directory), registry.gemma.requiredFiles));
}

export function validRegistration(value) {
  return value?.version === 1 && [value.pythonExecutable, value.modelsRoot].every(item =>
    typeof item === 'string' && path.isAbsolute(item)) &&
    Array.isArray(value.modelIds) && value.modelIds.length > 0 && value.modelIds.length <= Object.keys(registry.models).length &&
    new Set(value.modelIds).size === value.modelIds.length && value.modelIds.every(id => Object.hasOwn(registry.models, id));
}

export function readLtxRegistration(file) {
  try {
    const info = lstatSync(file);
    if (info.isFile() && (info.mode & 0o077) === 0) {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      if (validRegistration(value)) return value;
    }
  } catch { /* missing or invalid registration */ }
  throw new Error('LTX registration is missing or invalid. Run model-dock ltx register.');
}
