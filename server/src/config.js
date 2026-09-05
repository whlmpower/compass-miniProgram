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
  conversationsDir: path.join(ROOT, 'data', 'conversations'),

  // LLM（OpenAI 兼容接口，默认 StepFun 阶跃星辰）
  llmApiKey: process.env.LLM_API_KEY || '',
  llmBaseUrl: process.env.LLM_BASE_URL || 'https://api.stepfun.com/v1',
  llmModel: process.env.LLM_MODEL || 'step-3.7-flash',
  llmTemperature: Number(process.env.LLM_TEMPERATURE || 0.8),
  // 仅在显式设置 LLM_MOCK=true 时启用演示兜底；默认走真实大模型（对话无须 mock）
  llmMock: process.env.LLM_MOCK === 'true',
  // 流式输出开关：true=边生成边返回（首字延迟低）；false=降级为一次性返回。
  // 两者对前端协议完全一致（均为 SSE 帧），线上出问题设 LLM_STREAM=false 即可秒级回滚，前端零改动。
  llmStream: process.env.LLM_STREAM !== 'false',
  // 对话阶段是否裁掉「评分层」提示词（scoring-rubrics.md + weights.md，约 8.3k 字符 / 16%）。
  // 这两个文件按 system.md 的约定只在「需要评分时 / 综合诊断时」使用，对话阶段用不到。
  // 设为 false 可回滚到全量注入。
  trimChatPrompt: process.env.TRIM_CHAT_PROMPT !== 'false',

  // 业务规则
  maxInputChars: Number(process.env.MAX_INPUT_CHARS || 1000),
  postReportTurns: Number(process.env.POST_REPORT_TURNS || 10),
  reportTtlHours: Number(process.env.REPORT_TTL_HOURS || 24),
  abandonTtlDays: Number(process.env.ABANDON_TTL_DAYS || 3),

  // 鉴权（v2）
  jwtSecret: process.env.JWT_SECRET || 'dev_insecure_secret_change_me',
  jwtExpiresHours: Number(process.env.JWT_EXPIRES_HOURS || 24),
  adminPhone: process.env.ADMIN_PHONE || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  userPwdTtlHours: Number(process.env.USER_PWD_TTL_HOURS || 24),

  // 安全加固（v2 安全审查后新增）
  cookieSecure: process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true',
  allowedOrigin: process.env.ALLOWED_ORIGIN || '', // 前后端不同源时填前端域名；同源留空
  trustProxy: process.env.TRUST_PROXY || false, // 部署在可信反向代理后填 'loopback'/'127.0.0.1'/'true'
  enableHsts: process.env.ENABLE_HSTS === 'true' || process.env.NODE_ENV === 'production',
  csp:
    process.env.CSP ||
    "default-src 'self'; img-src 'self' data:; font-src 'self' https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'",

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
