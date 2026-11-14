import { GatewayError } from '../../protocol/index.mjs';
import { imageInfo } from '../../protocol/image-data.mjs';
import { maxImageResultBytes } from '../../protocol/image-options.mjs';
import { CodexClient } from './client.mjs';

const imageModelId = 'codex-imagegen';

function selectImageModel(models) {
  const candidates = models.filter(model => model.inputModalities?.includes('image'));
  return candidates.find(model => model.isDefault) || candidates[0];
}

function encodeImage(result) {
  const invalid = () => new GatewayError('Codex did not return a supported image.', 502, 'codex_image_result_invalid');
  if (typeof result !== 'string') throw invalid();
  const encoded = result.trim().replace(/^data:image\/(?:png|jpeg|webp);base64,/i, '').replace(/[\r\n]/g, '');
  const tooLarge = () => new GatewayError('The generated image exceeds 30 MiB.', 502, 'output_limit');
  if (encoded.length > Math.ceil(maxImageResultBytes / 3) * 4) throw tooLarge();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw invalid();
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > maxImageResultBytes) throw tooLarge();
  const info = imageInfo(bytes);
  if (!info) throw invalid();
  return { b64_json: bytes.toString('base64'), ...info };
}

export function createCodexProvider(options = {}) {
  const client = new CodexClient(options);
  const imageClient = new CodexClient({ ...options, imageGeneration: true });
  return {
    async discover(connection, { signal }) {
      const models = await client.models(signal);
      const catalog = models.filter(model => model.id !== imageModelId).map(model => ({
        nativeId: model.id, name: model.displayName || model.id,
        capabilities: { text: true, tools: true, structured: true },
        reasoningEfforts: (model.supportedReasoningEfforts || []).map(value => value.reasoningEffort || value.effort || value).filter(value => typeof value === 'string'),
        defaultEffort: model.defaultReasoningEffort || null,
        details: 'Local Codex CLI bridge. Inference uses the account/provider configured in Codex.'
      }));
      if (selectImageModel(models)) {
        const probe = AbortSignal.any([signal, AbortSignal.timeout(6000)]);
        const supported = await imageClient.supportsImageGeneration(probe).catch(() => false);
        if (supported) {
          catalog.push({
            nativeId: imageModelId, name: imageModelId, capability: 'image_generation',
            capabilities: { image_generation: true, text: false, tools: false, structured: false, thinking: false },
            reasoningEfforts: [], defaultEffort: null,
            details: 'Native image generation and reference-based editing using the local Codex sign-in.'
          });
        }
      }
      return catalog;
    },
    async generateImage(_connection, request, { signal }) {
      const model = selectImageModel(await imageClient.models(signal));
      if (!model || !await imageClient.supportsImageGeneration(signal)) {
        throw new GatewayError('Native image generation is unavailable in the local Codex runtime.', 503, 'codex_image_unavailable');
      }
      const { image, usage } = await imageClient.runImage(model.id, request, signal);
      return { ...encodeImage(image), usage };
    },
    async *generate(connection, request, { signal, model }) {
      const allowed = ['model', 'messages', 'stream', 'stream_options', 'tools', 'tool_choice', 'parallel_tool_calls', 'response_format', 'reasoning_effort'];
      for (const key of Object.keys(request)) if (!allowed.includes(key)) throw new GatewayError(`Codex cannot enforce ${key}; omit this parameter.`, 400, 'unsupported_parameter', key);
      if (request.parallel_tool_calls === true) throw new GatewayError('Codex bridge currently hands off one function per request.', 400, 'unsupported_parameter', 'parallel_tool_calls');
      if (request.tools?.some(tool => tool.function.strict === true)) throw new GatewayError('Codex dynamic functions cannot guarantee strict schemas.', 400, 'unsupported_parameter', 'tools.function.strict');
      if (request.reasoning_effort && !model.reasoningEfforts?.includes(request.reasoning_effort)) throw new GatewayError('This reasoning effort was not declared by the model.', 400, 'unsupported_parameter', 'reasoning_effort');
      const queue = []; let wake, finished = false, result, failure;
      const task = client.run(request, { signal, onDelta(content) { queue.push({ type: 'delta', delta: { content } }); wake?.(); } })
        .then(value => { result = value; }, error => { failure = error; }).finally(() => { finished = true; wake?.(); });
      while (!finished || queue.length) {
        if (!queue.length) await new Promise(resolve => { wake = resolve; });
        while (queue.length) yield queue.shift();
      }
      await task; if (failure) throw failure;
      if (result.toolCalls?.length) yield { type: 'delta', delta: { tool_calls: result.toolCalls.map((call, index) => ({ index, ...call })) } };
      if (result.usage) yield { type: 'usage', usage: result.usage };
      yield { type: 'done', finishReason: result.finishReason };
    },
    close: () => Promise.allSettled([client.stop(), imageClient.stop()])
  };
}
