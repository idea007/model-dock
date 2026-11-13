// This catalog belongs to the consuming application, not to the model gateway.
export const FEATURE_KINDS = {
  chat: { label: '自由对话', instruction: '你是一个简洁、可靠的助手。请回答用户的问题。' },
  extract: { label: '结构化提取', instruction: '从用户文本中提取关键信息，以一个 JSON 对象返回。', structured: true },
  summarize: { label: '文档摘要', instruction: '概括用户提供的文本，给出简洁摘要和关键要点。' },
  rewrite: { label: '文本润色', instruction: '在保留原意的前提下润色用户文本，直接给出修改后的内容。' },
  translate: { label: '多语言翻译', instruction: '将用户文本翻译成英文；如果原文主要是英文，则翻译成中文。只返回译文。' },
  explain: { label: '代码讲解', instruction: '解释用户代码的作用、执行过程和重要边界。' },
  review: { label: '代码审查', instruction: '审查用户代码，指出具体的问题、影响和改进建议。' }
};
export const initialFeatures = () => [
  { id: 'chat', name: '自由对话', kind: 'chat', group: '', selection: 'single' },
  { id: 'extract', name: '结构化提取', kind: 'extract', group: '', selection: 'single' },
  { id: 'summarize', name: '文档摘要', kind: 'summarize', group: '内容处理', selection: 'multiple' },
  { id: 'rewrite', name: '文本润色', kind: 'rewrite', group: '内容处理', selection: 'multiple' },
  { id: 'translate', name: '多语言翻译', kind: 'translate', group: '内容处理', selection: 'multiple' },
  { id: 'explain-code', name: '代码讲解', kind: 'explain', group: '开发助手', selection: 'multiple' },
  { id: 'review-code', name: '代码审查', kind: 'review', group: '开发助手', selection: 'multiple' }
].map(feature => ({ ...feature, modelId: '', allowedModelIds: [], reasoningOverrides: {} }));
