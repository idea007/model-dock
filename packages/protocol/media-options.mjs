const MiB = 1024 * 1024;

export const mediaInterfaces = {
  speech: { path: '/audio/speech', profiles: ['speech', 'minimax-speech', 'edge-tts'] },
  transcription: { path: '/audio/transcriptions', profiles: ['transcription'] },
  video: { path: '/videos', profiles: ['local-ltx', 'seedance', 'minimax-video', 'wan'] },
  embeddings: { path: '/embeddings', profiles: ['embedding'] }
};

export const maxAudioFileBytes = 25 * MiB;
export const maxStandardTranscriptionBytes = 26 * MiB;
export const maxStandardVideoBytes = 16 * MiB;
export const localVideoSizes = ['512x320', '768x448', '320x512', '448x768'];
export const cloudVideoSizes = ['1280x720', '720x1280', '1920x1080', '1080x1920', '1792x1024', '1024x1792'];
export const requiredVideoModelProfiles = ['seedance', 'wan'];

export const isMlxKokoro = model => /^mlx-community\/Kokoro-82M-(?:4bit|8bit|bf16)$/.test(model || '');
