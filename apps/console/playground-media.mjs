import { cloudVideoSizes, isMlxKokoro, localVideoSizes, maxAudioFileBytes, maxStandardVideoBytes, mediaInterfaces, requiredVideoModelProfiles } from '../../packages/protocol/media-options.mjs';
import { LocalizedError, t } from '../../packages/ui/i18n.mjs';
import { curl, formCurl } from './api-docs.mjs';

export const playgroundModes = {
  chat: 'docs.chat', image: 'docs.images', speech: 'docs.speech', transcription: 'docs.transcription',
  video: 'console.testVideo', embeddings: 'docs.embeddings'
};

export function playgroundMode(model) {
  if (!model) return;
  if (model.capability === 'image_generation') return 'image';
  if (model.service) return Object.keys(mediaInterfaces).find(mode => mediaInterfaces[mode].profiles.includes(model.service));
  if (model.capabilities?.text !== false) return 'chat';
}

export const playgroundNeedsBinding = (model, upstream) => requiredVideoModelProfiles.includes(model.service) && !upstream;

const voiceOptions = {
  'edge-tts': ['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural'],
  'minimax-speech': ['male-qn-qingse']
};
const voices = (service, upstream) => voiceOptions[service] || (isMlxKokoro(upstream) ? ['zf_xiaobei', 'zf_xiaoxiao', 'zm_yunxi'] : ['alloy']);

export function mediaFields() {
  return `<fieldset class="play-media-options" data-play-mode="speech" hidden disabled>
      <div class="form-grid">
        <label>${t('console.testVoice')}<input name="voice" list="play-voice-options" maxlength="300" autocomplete="off" required>
          <datalist id="play-voice-options"></datalist></label>
        <label>${t('console.testSpeechSpeed')}<input name="speech_speed" type="number" min="0.25" max="4" step="any" value="1"></label>
      </div>
      <small>${t('console.testVoiceHelp')}</small>
    </fieldset>
    <fieldset class="play-media-options" data-play-mode="transcription" hidden disabled>
      <label>${t('console.testAudioFile')}<input name="audio_file" type="file" accept="audio/*,.mp4,.m4a,.mp3,.wav,.flac,.ogg,.webm,.mpeg,.mpga" required>
        <small>${t('console.testAudioLimit')}</small></label>
      <label>${t('console.testTranscriptionLanguage')}<input name="audio_language" maxlength="12" placeholder="${t('console.testLanguagePlaceholder')}"></label>
    </fieldset>
    <fieldset class="play-media-options" data-play-mode="video" hidden disabled>
      <div class="form-grid">
        <label>${t('console.testVideoSeconds')}<input name="video_seconds" type="number" min="1" max="30" step="1" value="4"></label>
        <label>${t('console.testVideoSize')}<select name="video_size"></select></label>
      </div>
      <label>${t('console.testVideoFrame')}<input name="video_frame" type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp">
        <small>${t('console.testVideoFrameHelp')}</small></label>
    </fieldset>`;
}

export function updateMediaFields(form, mode, model, upstream) {
  for (const group of form.querySelectorAll('[data-play-mode]')) group.hidden = group.disabled = group.dataset.playMode !== mode;
  if (mode === 'speech') {
    const { voice, speech_speed: speed } = form.elements;
    const options = voices(model?.service, upstream);
    const native = Boolean(voiceOptions[model?.service]);
    if (voice.dataset.model !== model?.id) {
      voice.dataset.model = model?.id || '';
      voice.value = options[0];
    }
    speed.min = native ? '0.5' : '0.25';
    speed.max = native ? '2' : '4';
    if (speed.value && !speed.validity.valid) speed.value = '1';
    const list = form.querySelector('#play-voice-options');
    list.replaceChildren(...options.map(value => Object.assign(document.createElement('option'), { value })));
  }
  if (mode === 'video') {
    const local = model?.service === 'local-ltx';
    const { video_seconds: seconds, video_size: size } = form.elements;
    seconds.readOnly = local;
    if (local) seconds.value = '4';
    const sizes = local ? localVideoSizes : cloudVideoSizes;
    const previous = size.value;
    size.replaceChildren(new window.Option(t('console.automatic'), ''), ...sizes.map(value => new window.Option(value, value)));
    if (sizes.includes(previous)) size.value = previous;
  }
}

export function mediaExample(baseUrl, { mode, id, service, upstream }) {
  const model = id || `connection-id/${mediaInterfaces[mode].profiles[0]}`;
  const endpoint = baseUrl + mediaInterfaces[mode].path;
  if (mode === 'transcription') return formCurl(endpoint, { model, response_format: 'json' }, 'file=@audio.wav');
  if (mode === 'speech') {
    return curl(endpoint, { model, input: t('docs.greetingPrompt'), voice: voices(service, upstream)[0], response_format: 'mp3' }, { output: 'speech.mp3' });
  }
  if (mode === 'embeddings') return curl(endpoint, { model, input: t('docs.greetingPrompt'), encoding_format: 'float' });
  return curl(endpoint, { model, prompt: t('docs.videoPrompt'), seconds: '4' });
}

function waitForPoll(milliseconds, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, milliseconds);
    function stop() { clearTimeout(timer); reject(signal.reason); }
    signal.addEventListener('abort', stop, { once: true });
  });
}

async function mediaFile(response, type, filename) {
  const mime = response.headers.get('content-type')?.split(';', 1)[0]?.toLowerCase();
  if (!mime || (type === 'video' ? mime !== 'video/mp4' : !mime.startsWith('audio/') && mime !== 'application/octet-stream')) {
    throw new LocalizedError('console.testInvalidMedia');
  }
  const result = await response.blob();
  if (!result.size) throw new LocalizedError('console.testInvalidMedia');
  const blob = type === 'audio' && ['audio/mp3', 'application/octet-stream'].includes(mime) ? result.slice(0, result.size, 'audio/mpeg') : result;
  const audioExtensions = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'audio/ogg': 'ogg', 'audio/aac': 'aac', 'audio/mp4': 'm4a' };
  return { blob, element: type, filename: type === 'audio' ? `speech.${audioExtensions[mime] || 'mp3'}` : filename };
}

export function videoStatus(job) {
  const keys = { queued: 'console.testVideoQueued', in_progress: 'console.testVideoRunning', completed: 'common.completed', failed: 'common.failed' };
  return keys[job?.status];
}

async function generateVideo({ model, fields, signal, api, job, onVideo, onDownload }) {
  const endpoint = '/v1' + mediaInterfaces.video.path;
  const frame = fields.get('video_frame');
  if (!job) {
    if (frame?.size > maxStandardVideoBytes) throw new LocalizedError('console.testVideoTooLarge');
    const seconds = fields.get('video_seconds'), size = fields.get('video_size');
    let body = { model: model.id, prompt: fields.get('prompt'), ...(seconds && { seconds }), ...(size && { size }) };
    if (frame?.name) {
      const upload = new FormData();
      for (const [key, value] of Object.entries(body)) upload.set(key, value);
      upload.set('input_reference', frame);
      body = upload;
    }
    job = await api(endpoint, { method: 'POST', body, signal });
  }
  const id = job?.id;
  const update = next => {
    if (!/^video_[a-f0-9]{32}$/.test(id || '') || next?.id !== id || !videoStatus(next)) {
      throw new LocalizedError('console.testInvalidVideo');
    }
    onVideo(next);
    return next;
  };
  job = update(job);
  const path = `${endpoint}/${id}`;
  while (job.status === 'queued' || job.status === 'in_progress') {
    await waitForPoll(2000, signal);
    job = update(await api(path, { signal }));
  }
  if (job.status === 'failed') throw job.error || new LocalizedError('console.testVideoFailed');
  onDownload();
  const response = await api(`${path}/content`, { signal, redirect: 'error', headers: { accept: 'video/mp4' } }, true);
  return { file: await mediaFile(response, 'video', `${id}.mp4`) };
}

export async function generateMedia({ mode, model, fields, signal, api, job, onVideo, onDownload }) {
  if (mode === 'video') return generateVideo({ model, fields, signal, api, job, onVideo, onDownload });
  const endpoint = '/v1' + mediaInterfaces[mode].path;
  if (mode === 'transcription') {
    const file = fields.get('audio_file');
    if (!file?.size || file.size > maxAudioFileBytes) throw new LocalizedError('console.testAudioLimit');
    const body = new FormData();
    body.set('model', model.id);
    body.set('file', file);
    body.set('response_format', 'json');
    const language = fields.get('audio_language')?.trim();
    if (language) body.set('language', language);
    const result = await api(endpoint, { method: 'POST', body, signal });
    if (typeof result?.text !== 'string') throw new LocalizedError('console.testInvalidTranscript');
    return { content: result.text || t('console.testEmptyTranscript') };
  }
  const input = fields.get('prompt');
  if (mode === 'speech') {
    const speed = fields.get('speech_speed');
    const body = { model: model.id, input, voice: fields.get('voice').trim(), response_format: 'mp3', ...(speed && { speed: Number(speed) }) };
    const response = await api(endpoint, { method: 'POST', body, signal }, true);
    return { file: await mediaFile(response, 'audio') };
  }
  const result = await api(endpoint, { method: 'POST', body: { model: model.id, input, encoding_format: 'float' }, signal });
  if (!Array.isArray(result?.data) || !result.data.every(item => Array.isArray(item?.embedding))) {
    throw new LocalizedError('console.testInvalidEmbedding');
  }
  return { content: JSON.stringify(result, null, 2) };
}
