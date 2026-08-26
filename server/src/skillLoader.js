import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const SKILL = config.skillDir;

function read(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

// 始终进入 system prompt 的核心文件（角色 + 流程 + 诊断框架 + 金句）
const CORE_PROMPT_FILES = [
  'prompts/system.md',
  'prompts/warmup.md',
  'prompts/socratic.md',
  'prompts/reference-select.md',
  'prompts/dimensions.md',
  'prompts/synthesize.md',
  'prompts/jailbreak.md',
  'references/insights.md',
];

const FRAMEWORK_FILES = [
  'frameworks/bigfive.md',
  'frameworks/schein.md',
  'frameworks/schwartz.md',
  'frameworks/attachment.md',
  'frameworks/risk-tolerance.md',
  'frameworks/family-anchor.md',
  'frameworks/scoring-rubrics.md',
  'frameworks/weights.md',
];

export function buildSystemPrompt() {
  const parts = [];
  for (const f of CORE_PROMPT_FILES) {
    const c = read(path.join(SKILL, f));
    if (c) parts.push(`\n\n# 文件: ${f}\n${c}`);
  }
  for (const f of FRAMEWORK_FILES) {
    const c = read(path.join(SKILL, f));
    if (c) parts.push(`\n\n# 框架文件: ${f}\n${c}`);
  }
  return parts.join('\n');
}

const REFERENCERS = [
  'bigtech-vs-soe',
  'civil-service',
  'foreign-enterprise',
  'startup',
  'side-hustle',
  'education-vs-career',
];

// 参照系 id -> research 子目录名（education-vs-career 在 research 里叫 graduate-vs-work；side-hustle 暂无 research）
const RESEARCH_MAP = {
  'bigtech-vs-soe': 'bigtech-vs-soe',
  'civil-service': 'civil-service',
  'foreign-enterprise': 'foreign-enterprise',
  'startup': 'startup',
  'education-vs-career': 'graduate-vs-work',
  'side-hustle': null,
};

// 确定性开场白：避免拿空历史调 LLM 导致模型「脑补」场景（如自行假定用户在央企/投行二选一）。
// 直接使用 warmup.md 定义的统一开场话术，保证每个新会话（无论新老账号）首句一致、无上下文污染。
export function buildGreeting() {
  const c = read(path.join(SKILL, 'prompts/greeting.md')).trim();
  return (
    c ||
    '你好，我是「职业罗盘」。今天我想陪你一起看看，那些让你纠结的东西，到底在告诉你什么。先跟我聊聊你现在的处境吧——你现在在哪里工作或读书？最近遇到了什么让你感到纠结的事情？想到什么说什么就行，我会在关键的地方追问你。'
  );
}

export function listReferencers() {
  return REFERENCERS.map((id) => {
    const meta = read(path.join(SKILL, 'referencers', id, 'meta.json'));
    let name = id;
    try {
      name = JSON.parse(meta).name || id;
    } catch {
      /* ignore */
    }
    return { id, name };
  });
}

// 生成报告时注入：报告模板 + 用户所选参照系的专属资料
export function buildReportInstruction(referencerId) {
  const tpl = read(path.join(SKILL, 'prompts/report.md'));
  let refContent = '';
  if (referencerId && REFERENCERS.includes(referencerId)) {
    const dir = path.join(SKILL, 'referencers', referencerId);
    for (const f of ['report-addon.md', 'outcomes.md', 'insights.md']) {
      const c = read(path.join(dir, f));
      if (c) refContent += `\n\n# 参照系资料: ${referencerId}/${f}\n${c}`;
    }
    const researchId = RESEARCH_MAP[referencerId];
    if (researchId) {
      const rc = read(path.join(SKILL, 'research', researchId, 'research-notes.md'));
      if (rc) refContent += `\n\n# 事实依据资料（research/${researchId}）\n${rc}`;
    }
  }
  return `你现在需要为用户生成《职业自我认知报告》。请严格遵循以下报告模板与结构，结合上面完整对话内容，输出一份 Markdown 格式的报告。\n\n${tpl}\n${refContent}\n\n要求：\n- 报告必须包含伦理声明（含危机求助热线）。\n- 用「你」直接对话用户，基于对话中的具体案例，不要空泛。\n- 雷达图同时提供 Mermaid 代码块和文字版表格（作为 fallback）。\n- 只输出报告正文，不要输出任何额外解释或寒暄。`;
}
