/**
 * i18n 键校验（对照 AstrBot 的 i18n:check 思路，适配本项目的两套扁平文案）。
 *
 * 做三件事：
 * 1. zh-CN / en-US 两套文案的键集合必须完全一致，且没有空字符串；
 * 2. 扫描 webui/src 中所有静态 `t('...')` 用法，确保键在文案里存在
 *    （老前端曾出现「用了不存在的键 → 界面直接显示键名」的问题）；
 * 3. 校验模板字符串形式的动态键（如 `platform.modes.${mode}`）的已知取值。
 *
 * 运行：npm run test:i18n（根目录）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import enUS from '../src/i18n/locales/en-US';
import zhCN from '../src/i18n/locales/zh-CN';

type MessageTree = { [key: string]: string | MessageTree };

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));
const problems: string[] = [];

function flatten(tree: MessageTree, prefix = '', out = new Map<string, string>()): Map<string, string> {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else flatten(value, path, out);
  }
  return out;
}

const zh = flatten(zhCN as unknown as MessageTree);
const en = flatten(enUS as unknown as MessageTree);

// 1. 键集合与空值
for (const key of zh.keys()) {
  if (!en.has(key)) problems.push(`en-US 缺少键: ${key}`);
}
for (const key of en.keys()) {
  if (!zh.has(key)) problems.push(`en-US 多出键: ${key}`);
}
for (const [key, value] of zh) {
  if (!value.trim()) problems.push(`zh-CN 空文案: ${key}`);
}
for (const [key, value] of en) {
  if (!value.trim()) problems.push(`en-US 空文案: ${key}`);
}

// 2. 静态使用扫描
function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue;
      walk(full, files);
    } else if (full.endsWith('.ts') || full.endsWith('.vue')) {
      if (full.includes(`${join('i18n', 'locales')}`)) continue;
      files.push(full);
    }
  }
  return files;
}

const usedKeys = new Set<string>();
const dynamicPrefixes = new Set<string>();

for (const file of walk(SRC_DIR)) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/\bt\(\s*'([^'$]+)'/g)) {
    if (match[1]) usedKeys.add(match[1]);
  }
  for (const match of source.matchAll(/\btranslate\(\s*'([^'$]+)'/g)) {
    if (match[1]) usedKeys.add(match[1]);
  }
  for (const match of source.matchAll(/\bt\(\s*`([^`]+)`/g)) {
    const template = match[1] ?? '';
    const interpolation = template.indexOf('${');
    if (interpolation > 0) dynamicPrefixes.add(template.slice(0, interpolation));
  }
}

for (const key of [...usedKeys].sort()) {
  if (!zh.has(key)) problems.push(`代码使用但文案缺失: ${key}`);
}

/** 动态键的已知取值：出现新的 ${...} 模板时需要在这里补充 */
const dynamicVariants: Record<string, string[]> = {
  'platform.modes.': ['off', 'forward', 'reverse', 'both'],
  'providers.families.': ['language', 'speech-to-text', 'embedding', 'rerank'],
};

for (const prefix of [...dynamicPrefixes].sort()) {
  const variants = dynamicVariants[prefix];
  if (!variants) {
    problems.push(`未登记的动态键前缀: ${prefix}（请在 check-i18n.ts 的 dynamicVariants 中补充）`);
    continue;
  }
  for (const variant of variants) {
    const key = `${prefix}${variant}`;
    if (!zh.has(key)) problems.push(`动态键缺失: ${key}`);
  }
}

// 3. 报告
console.log('i18n check');
console.log(`  zh-CN keys: ${zh.size}`);
console.log(`  en-US keys: ${en.size}`);
console.log(`  静态使用的键: ${usedKeys.size}`);
console.log(`  动态键前缀: ${[...dynamicPrefixes].sort().join(', ') || '(none)'}`);

if (problems.length > 0) {
  console.error(`\n✗ ${problems.length} 个问题:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log('\n✓ i18n 键检查通过');
}
