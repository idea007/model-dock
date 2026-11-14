import { t } from './i18n.mjs';
import { messages } from './messages.mjs';

const builtInFeatures = new Map([
  ['chat', 'feature.chat'],
  ['extract', 'feature.extract'],
  ['summarize', 'feature.summarize'],
  ['rewrite', 'feature.rewrite'],
  ['translate', 'feature.translate'],
  ['explain-code', 'feature.explain'],
  ['review-code', 'feature.review']
]);

const builtInGroups = new Map([
  ['内容处理', 'group.content'],
  ['开发助手', 'group.development']
]);

export function featureName(feature) {
  const key = builtInFeatures.get(feature.id);
  return key && feature.name === messages[key][0] ? t(key) : feature.name;
}

export function groupName(name) {
  const key = builtInGroups.get(name);
  return key ? t(key) : name;
}
