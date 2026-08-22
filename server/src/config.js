import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const config = {
  port: Number(process.env.PORT) || 3001,
  rootDir: ROOT,
  skillDir: path.join(ROOT, 'skill'),
  dataDir: path.join(ROOT, 'data'),
  sessionsDir: path.join(ROOT, 'data', 'sessions'),
  reportsDir: path.join(ROOT, 'data', 'reports'),

  // LLM（OpenAI 兼容接口，默认 StepFun 阶跃星辰）
  llmApiKey: process.env.LLM_API_KEY || '',
  llmBaseUrl: process.env.LLM_BASE_URL || 'https://api.stepfun.com/v1',
  llmModel: process.env.LLM_MODEL || 'step-3.7-flash',
  llmTemperature: Number(process.env.LLM_TEMPERATURE || 0.8),
  // 仅在显式设置 LLM_MOCK=true 时启用演示兜底；默认走真实大模型（对话无须 mock）
  llmMock: process.env.LLM_MOCK === 'true',

  // 业务规则
  maxInputChars: Number(process.env.MAX_INPUT_CHARS || 5000),
  postReportTurns: Number(process.env.POST_REPORT_TURNS || 10),
  reportTtlHours: Number(process.env.REPORT_TTL_HOURS || 24),
  abandonTtlDays: Number(process.env.ABANDON_TTL_DAYS || 3),

  // 鉴权（v2）
  jwtSecret: process.env.JWT_SECRET || 'dev_insecure_secret_change_me',
  jwtExpiresHours: Number(process.env.JWT_EXPIRES_HOURS || 24),
  adminPhone: process.env.ADMIN_PHONE || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  userPwdTtlHours: Number(process.env.USER_PWD_TTL_HOURS || 24),

  // 限流（v2）
  ratePhoneMax: Number(process.env.RATE_PHONE_MAX || 5),
  rateIpMax: Number(process.env.RATE_IP_MAX || 10),
  rateWindowHours: Number(process.env.RATE_WINDOW_HOURS || 24),

  // 文件路径
  usersFile: path.join(ROOT, 'data', 'users.json'),
  ratelimitFile: path.join(ROOT, 'data', 'ratelimit.json'),
};

// 仅当显式开启 LLM_MOCK 时才进入演示兜底模式；否则一律走真实大模型
export const isMock = () => config.llmMock;
