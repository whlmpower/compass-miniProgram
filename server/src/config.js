import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const config = {
  port: Number(process.env.PORT) || 3001,
  rootDir: ROOT,
  skillDir: path.join(ROOT, 'skill'),
  dataDir: path.join(ROOT, 'data'),
  sessionsDir: path.join(ROOT, 'data', 'sessions'),
  reportsDir: path.join(ROOT, 'data', 'reports'),

  // LLM（OpenAI 兼容接口，默认 DeepSeek）
  llmApiKey: process.env.LLM_API_KEY || '',
  llmBaseUrl: process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1',
  llmModel: process.env.LLM_MODEL || 'deepseek-chat',
  llmTemperature: Number(process.env.LLM_TEMPERATURE || 0.8),

  // 业务规则
  maxInputChars: Number(process.env.MAX_INPUT_CHARS || 5000),
  postReportTurns: Number(process.env.POST_REPORT_TURNS || 10),
  reportTtlHours: Number(process.env.REPORT_TTL_HOURS || 24),
  adDurationSec: Number(process.env.AD_DURATION_SEC || 10),
  abandonTtlDays: Number(process.env.ABANDON_TTL_DAYS || 3),
};

// 未配置 API Key 时自动进入 mock 模式（无需联网即可演示完整流程）
export const isMock = () => !config.llmApiKey;
