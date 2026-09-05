import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { config, isMock } from './config.js';
import {
  buildSystemPrompt,
  buildReportInstruction,
  buildGreeting,
  listReferencers,
  systemPromptStats,
} from './skillLoader.js';
import { chat, chatStream, mockReport } from './llm.js';
import { renderReportHtml } from './report.js';
import { renderConversationHtml, buildConversationFileName } from './conversation.js';
import {
  createSession,
  getSession,
  getLatestValidSessionForPhone,
  addMessage,
  setReport,
  setConversation,
  persist,
} from './store.js';
import {
  requireAuth,
  requireAdmin,
  signToken,
  signScopedToken,
  verifyScopedToken,
  getClientIp,
  setAuthCookie,
  clearAuthCookie,
} from './auth.js';
import { generateCaptcha, verifyCaptcha } from './captcha.js';
import {
  initAdmin,
  createUser,
  resetPassword,
  revokeUser,
  listUsers,
  authenticate,
  changeAdminPassword,
  getUserByEmail,
  createSelfAccount,
  validateSelfPassword,
} from './users.js';
import { check, record } from './ratelimit.js';
import { sendVerificationCode } from './email.js';
import { requestCode, verifyCode } from './emailcode.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- 日志：同时落盘到 data/server.log，便于排查“卡住/无响应” ----------
const LOG_PATH = path.join(config.dataDir, 'server.log');
function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
function logToFile(line) {
  try {
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch {
    /* 日志写入失败不应影响主流程 */
  }
}
const origLog = console.log.bind(console);
console.log = (...args) => {
  const line = `[${ts()}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  origLog(line);
  logToFile(line);
};
const origErr = console.error.bind(console);
console.error = (...args) => {
  const line = `[${ts()}] [ERR] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  origErr(line);
  logToFile(line);
};

// ---------- Express 实例 + 访问日志中间件 ----------
const app = express();

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`HTTP ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
  });
  next();
});

app.set('trust proxy', config.trustProxy); // 受 config.trustProxy 控制，默认不信任 XFF

// CORS：仅当配置了 ALLOWED_ORIGIN（前后端不同源）才开放；同源部署不挂载
if (config.allowedOrigin) {
  app.use(cors({ origin: config.allowedOrigin, credentials: true }));
}

// 安全响应头（零依赖，手动设置）
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', config.csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (config.enableHsts) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.use(express.json({ limit: '1mb' }));

// 静态资源：H5 前端（报告仅通过鉴权接口下载，不在此公开挂载）
app.use(express.static(path.join(config.rootDir, '..', 'web')));

// 启动安全校验：JWT_SECRET 过弱时，生产环境直接拒绝启动
(function validateSecrets() {
  const weak =
    !config.jwtSecret || config.jwtSecret === 'dev_insecure_secret_change_me' || config.jwtSecret.length < 16;
  if (weak) {
    if (process.env.NODE_ENV === 'production' || process.env.REQUIRE_STRONG_SECRET === 'true') {
      console.error('[致命] JWT_SECRET 仍为默认/弱密钥，生产环境必须设置强随机值后再启动。进程退出。');
      process.exit(1);
    }
    console.warn('[安全警告] JWT_SECRET 仍是默认/弱密钥，生产环境必须更换为强随机值！');
  }
})();

initAdmin();
// 全量提示词：仅「报告生成」阶段使用（需要评分锚点与权重矩阵）
const sysPrompt = buildSystemPrompt({ phase: 'full' });
// 对话阶段提示词：裁掉评分层（scoring-rubrics + weights），降低每轮预填 token（P3）
const chatSysPrompt = buildSystemPrompt({ phase: 'chat' });
{
  const st = systemPromptStats();
  const cut = st.full ? (((st.full - st.chat) / st.full) * 100).toFixed(1) : '0';
  console.log(`[prompt] 字符数 chat=${st.chat} full=${st.full} 对话阶段削减=${cut}%`);
}

// ---------- SSE 流式响应（P1 主线 A） ----------
// X-Accel-Buffering: no 用于禁用 Nginx 缓冲。注意：生产 Nginx 侧还需配合
//   proxy_buffering off;  proxy_cache off;  chunked_transfer_encoding on;
// 否则流式仍会被缓冲成「一次性返回」，首字延迟优势全部失效。
function sseInit(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders(); // 立即下发响应头，让前端 fetch 马上拿到 body 可读
}
function sseSend(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// ---------- 会话级生成状态（内存态，不持久化） ----------
// 用于「生成与连接解耦」：客户端连接被 OS 掐断后，生成任务仍继续跑，
// 前端回前台轮询该状态即可拿到完整回复。键为 sessionId。
//   generating : 是否正在生成（本轮对话/报告）
//   draft      : 已生成的累计文本（生成中时可被读取，供前端判断是否仍在生成）
//   clientGone : 客户端连接是否已断开（断开后只写 draft，不再向死 socket 推送）
const genState = new Map();
function getGen(sid) {
  return genState.get(sid);
}

function publicConfig() {
  return {
    features: { ads: false },
    maxInputChars: config.maxInputChars,
    maxPostReportRounds: config.postReportTurns,
    retentionHours: config.reportTtlHours,
    mock: isMock(),
    referencers: listReferencers(),
  };
}

// 报告生成后，AI 在对话框内追加的追问（用户语义判断「需要/不用」）
const CONVERSATION_FOLLOWUP =
  '已为你生成上方的诊断报告。需要我把本次完整对话（含这份报告）整理成一份 HTML 文件供你下载保存吗？回复「需要」即可生成，回复「不用」则跳过。';

// 用户回复意图识别：是否需要整理对话为 HTML（后端关键词兜底，确定性触发）
function wantsConversation(text) {
  return /(需要|要下载|下载|整理|打包|导出|保存|生成文件|给我文件)/.test(text);
}
function refusesConversation(text) {
  return /(不用|不需要|跳过|算了|暂时不|暂不需要)/.test(text);
}

// 后端确定性回复（拦截式：命中意图时不调用 LLM，避免 LLM 输出 HTML 源码噪音）
const NEED_REPLY =
  '好的，已为你整理好本次完整对话（含诊断报告），生成了一份 HTML 文件。\n\n点击对话页左下角的「下载报告」按钮，即可保存到你的手机或电脑本地。\n\n该文件将在生成后 24 小时自动删除，请及时下载保存。';
// 文件已生成后，用户再次表达下载意图时的兜底（仍不调 LLM，直接告知已就绪）
const NEED_READY_REPLY =
  '这份对话整理 HTML 已经生成好啦，无需重复生成。\n\n点击对话页左下角的「下载报告」按钮，即可直接保存到本地。\n\n该文件将在生成后 24 小时自动删除，请及时下载。';
const REFUSE_REPLY = '好的，你还有其他问题吗？';

// 报告后阶段用户意图的确定性处理（不调用 LLM）：
// 返回 { reply, justReady } 或 null（表示应走普通 LLM 对话）。
// 只要命中下载意图（需要/下载/整理/…）就拦截，避免 LLM 输出无关话术；
// 已生成则提示就绪、未生成则触发生成。
function resolvePostReportReply(s, content) {
  if (s.status !== 'reported') return null;
  if (wantsConversation(content)) {
    if (!s.conversationReady) {
      const justReady = generateConversation(s);
      return { reply: NEED_REPLY, justReady };
    }
    return { reply: NEED_READY_REPLY, justReady: false };
  }
  if (refusesConversation(content)) {
    return { reply: REFUSE_REPLY, justReady: false };
  }
  return null;
}
export { resolvePostReportReply };

// 把「到报告生成为止」的对话渲染为 HTML 并落盘，记录路径
function generateConversation(s) {
  // 前置守卫：无报告、无手机号、无有效消息 —— 拒绝生成，避免产出空壳文件污染下载
  if (!s.report || !s.report.markdown) return false;
  if (!s.phone || s.phone === '用户') return false;
  const preReport = s.messages.filter((m) => (m.ts || 0) <= s.report.generatedAt);
  if (preReport.length === 0) return false;
  const blocks = [
    ...preReport,
    { role: 'assistant', content: s.report.markdown, isReport: true },
  ];
  const html = renderConversationHtml({
    phone: s.phone,
    referencer: s.referencer,
    messages: blocks,
    generatedAt: s.report.generatedAt,
  });
  const fileName = buildConversationFileName(s.phone);
  const filePath = path.join(config.conversationsDir, fileName);
  fs.writeFileSync(filePath, html, { mode: 0o600 });
  setConversation(s, filePath);
  return true;
}

app.get('/api/config', (req, res) => {
  res.json(publicConfig());
});

// ---------- 认证与账号 ----------
app.post('/api/auth/captcha', (req, res) => {
  res.json(generateCaptcha());
});

app.post('/api/auth/login', (req, res) => {
  const { phone, captchaId, captchaInput, password } = req.body || {};
  // 参数格式校验
  if (!/^1\d{10}$/.test(phone || '')) {
    return res.status(400).json({ error: '请输入正确的 11 位手机号' });
  }
  if (!captchaId || typeof captchaInput !== 'string' || !password) {
    return res.status(400).json({ error: '参数缺失' });
  }
  // 1) 图形验证码先校验（错误只拦截本次，不计数）
  if (!verifyCaptcha(captchaId, captchaInput)) {
    return res.status(400).json({ error: '图形验证码不正确' });
  }
  const ip = getClientIp(req);
  // 2) 已达限流？直接拒绝
  const lim = check(phone, ip);
  if (!lim.allowed) {
    return res.status(429).json({ error: '尝试过多，请 24 小时后再试' });
  }
  // 3) 校验手机号 + 密码（防枚举：统一提示）
  const result = authenticate(phone, password);
  if (!result.ok) {
    record(phone, ip);
    const after = check(phone, ip);
    if (!after.allowed) {
      return res.status(429).json({ error: '尝试过多，请 24 小时后再试' });
    }
    return res.status(401).json({ error: '手机号或密码错误' });
  }
  const token = signToken({ phone, role: result.role });
  setAuthCookie(res, token); // httpOnly cookie 承载 JWT，防 XSS 盗取
  res.json({ token, role: result.role });
});

// 当前登录身份（供前端校验 token / 渲染角色）
app.get('/api/me', requireAuth, (req, res) => {
  res.json({ phone: req.user.phone, role: req.user.role });
});

// 退出登录：清除 httpOnly cookie
app.post('/api/auth/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

// ---------- 邮箱自注册（邀请码门控） ----------
// 1) 校验邀请码；通过则下发短期 invite token（5 分钟）。前端按钮解锁仅为 UX，服务端强制校验。
app.post('/api/auth/register/verify-invite', (req, res) => {
  const code = String((req.body && req.body.code) || '').trim();
  if (!config.inviteCode) return res.status(403).json({ error: '注册通道未开放' });
  const ip = getClientIp(req);
  const lim = check('invite', ip); // 轻量防爆破
  if (!lim.allowed) return res.status(429).json({ error: '尝试过多，请稍后再试' });
  if (code !== config.inviteCode) {
    record('invite', ip);
    return res.status(401).json({ error: '邀请码不正确' });
  }
  const token = signScopedToken({ scope: 'invite' }, 300);
  res.json({ ok: true, inviteToken: token });
});

// 2) 发送邮箱验证码：必须携带有效 invite token；邮箱不能已注册
app.post('/api/auth/register/send-code', (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const inviteToken = String((req.body && req.body.inviteToken) || '');
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: '请输入正确的邮箱地址' });
  try {
    verifyScopedToken(inviteToken, 'invite');
  } catch {
    return res.status(401).json({ error: '邀请码已失效，请重新验证' });
  }
  if (getUserByEmail(email)) return res.status(409).json({ error: '该邮箱已注册' });
  try {
    const code = requestCode(email);
    sendVerificationCode({ to: email, code }).catch((e) => console.error('[EMAIL] 发送失败:', e.message));
  } catch (e) {
    return res.status(429).json({ error: e.message });
  }
  res.json({ ok: true });
});

// 3) 校验邮箱验证码；通过则下发 reg-session token（15 分钟，携带已验证邮箱）
app.post('/api/auth/register/verify-email', (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const code = String((req.body && req.body.code) || '').trim();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: '请输入正确的邮箱地址' });
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: '请输入 6 位验证码' });
  try {
    verifyCode(email, code);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const token = signScopedToken({ scope: 'reg', email }, 900);
  res.json({ ok: true, regToken: token });
});

// 4) 绑定账号：凭 reg-session 设置手机号 + 自设密码，建号并登录
app.post('/api/auth/register/complete', (req, res) => {
  const regToken = String((req.body && req.body.regToken) || '');
  const phone = String((req.body && req.body.phone) || '').trim();
  const password = String((req.body && req.body.password) || '');
  let payload;
  try {
    payload = verifyScopedToken(regToken, 'reg');
  } catch {
    return res.status(401).json({ error: '注册会话已失效，请重新开始' });
  }
  const v = validateSelfPassword(password);
  if (!v.ok) return res.status(400).json({ error: v.error });
  if (!/^1\d{10}$/.test(phone)) return res.status(400).json({ error: '请输入正确的 11 位手机号' });
  const r = createSelfAccount(phone, payload.email, password);
  if (!r.ok) return res.status(409).json({ error: r.error });
  const token = signToken({ phone, role: 'user' });
  setAuthCookie(res, token);
  res.json({ token, role: 'user' });
});

// ---------- 管理后台（需 role=admin） ----------
const admin = express.Router();
admin.use(requireAuth, requireAdmin);

admin.post('/users', (req, res) => {
  const phone = (req.body?.phone || '').trim();
  if (!/^1\d{10}$/.test(phone)) {
    return res.status(400).json({ error: '请输入正确的 11 位手机号' });
  }
  try {
    const u = createUser(phone);
    res.json(u);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

admin.get('/users', (req, res) => {
  res.json({ users: listUsers() });
});

admin.post('/users/:phone/reset', (req, res) => {
  const r = resetPassword(req.params.phone);
  if (!r) return res.status(404).json({ error: '用户不存在' });
  res.json(r);
});

admin.post('/users/:phone/revoke', (req, res) => {
  const ok = revokeUser(req.params.phone);
  if (!ok) return res.status(404).json({ error: '用户不存在' });
  res.json({ ok: true });
});

admin.put('/password', (req, res) => {
  const { oldPwd, newPwd } = req.body || {};
  if (!oldPwd || !newPwd) return res.status(400).json({ error: '请输入旧密码与新密码' });
  const ok = changeAdminPassword(oldPwd, newPwd);
  if (!ok) return res.status(400).json({ error: '旧密码错误' });
  res.json({ ok: true });
});

app.use('/api/admin', admin);

// ---------- 诊断与会话（需任意有效 token；移除广告闸门） ----------

// 会话归属校验：会话一旦归属某用户（phone 存在），只有本人可读写；
// 归属他人一律按 404 处理（不暴露存在性）。无归属的旧数据（phone 缺失）放行，
// 待 cleanup 自然过期。
function assertOwner(req, s, res) {
  if (s.phone && s.phone !== req.user.phone) {
    res.status(404).json({ error: '会话不存在' });
    return false;
  }
  return true;
}

// 当前登录用户的最近有效会话（供前端刷新后恢复历史）
app.get('/api/sessions/mine', requireAuth, (req, res) => {
  const s = getLatestValidSessionForPhone(req.user.phone);
  if (!s) return res.json({ session: null });
  res.json({
    session: {
      id: s.id,
      status: s.status,
      referencer: s.referencer,
      reportReady: !!s.report,
      conversationReady: !!s.conversationReady,
      messageCount: s.messages.length,
    },
  });
});

app.post('/api/session', requireAuth, async (req, res) => {
  try {
    const referencer = req.body?.referencer || 'general';
    const s = createSession(referencer, req.user.phone);
    // 开场白使用确定性话术（greeting.md），不调 LLM：
    // 1) 避免空历史下模型脑补场景（如自行假定用户在央企/投行二选一）；
    // 2) 新账号首句与老账号恢复历史相互独立，杜绝跨用户上下文污染；
    // 3) 创建会话不再依赖外部 LLM，避免开场即「思考中」卡住。
    const greeting = buildGreeting();
    addMessage(s, 'assistant', greeting);
    res.json({ sessionId: s.id, greeting, config: publicConfig() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

app.get('/api/session/:id', requireAuth, (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: '会话不存在' });
  if (!assertOwner(req, s, res)) return;
  res.json({
    status: s.status,
    postReportTurns: s.postReportTurns,
    postReportTurnsLeft: Math.max(0, config.postReportTurns - s.postReportTurns),
    referencer: s.referencer,
    reportReady: !!s.report,
    reportHtml: s.report ? s.report.html || '' : '', // 报告正文（刷新恢复后报告页直接渲染，不依赖对话整理 HTML）
    conversationReady: !!s.conversationReady,
    messageCount: s.messages.length,
    // 生成状态（供前端切后台后静默恢复轮询）：generating=是否正在生成，draft=已生成累计文本
    generating: !!getGen(s.id)?.generating,
    draft: getGen(s.id)?.draft || '',
    messages: s.messages,
  });
});

app.post('/api/session/:id/message', requireAuth, async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: '会话不存在' });
  if (!assertOwner(req, s, res)) return;

  if (s.status === 'reported' && s.postReportTurns >= config.postReportTurns) {
    return res.status(403).json({ error: '报告后的追问轮次已用完，对话已结束' });
  }

  const content = (req.body?.content || '').trim();
  if (!content) return res.status(400).json({ error: '请输入内容' });
  if (content.length > config.maxInputChars) {
    return res.status(400).json({ error: `单轮输入不能超过 ${config.maxInputChars} 字` });
  }

  const tStart = Date.now();
  try {
    addMessage(s, 'user', content);

    // 报告已生成后：用关键词兜底识别用户意图（拦截式，不调用 LLM，避免 LLM 输出无关话术）
    let reply;
    let conversationJustReady = false;
    const intent = resolvePostReportReply(s, content);
    if (intent) {
      reply = intent.reply;
      conversationJustReady = intent.justReady;
    } else {
      const extraSystem =
        s.status === 'reported' && s.report
          ? `以下是已生成的报告全文，用户可能就报告内容追问：\n${s.report.markdown}`
          : '';
      reply = await chat(chatSysPrompt, s.messages, { extraSystem });
    }
    addMessage(s, 'assistant', reply);

    if (s.status === 'reported') {
      s.postReportTurns += 1;
      persist(s);
    }
    res.json({
      reply,
      conversationReady: !!s.conversationReady,
      conversationJustReady,
      postReportTurnsLeft: Math.max(0, config.postReportTurns - s.postReportTurns),
    });
    console.log(
      `[chat] sid=${s.id.slice(0, 8)} turns=${s.messages.length} promptChars=${chatSysPrompt.length} totalMs=${Date.now() - tStart} chars=${(reply || '').length}`
    );
  } catch (e) {
    console.error(
      `[chat] 失败 sid=${s.id.slice(0, 8)} totalMs=${Date.now() - tStart} err=${e?.message || e}`
    );
    res.status(502).json({ error: `模型调用失败：${e.message || e}` });
  }
});

// 流式对话（P1 主线 A）：边生成边返回，首字延迟从 30–90s 降至 1–3s。
// 协议：SSE 帧，delta=增量文本 / done=完成并携带元数据 / error=失败。
// 服务端始终以自身状态为准落库：即便客户端中途断开，用户刷新后仍可恢复完整回复。
app.post('/api/session/:id/message/stream', requireAuth, async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: '会话不存在' });
  if (!assertOwner(req, s, res)) return;

  if (s.status === 'reported' && s.postReportTurns >= config.postReportTurns) {
    return res.status(403).json({ error: '报告后的追问轮次已用完，对话已结束' });
  }

  const content = (req.body?.content || '').trim();
  if (!content) return res.status(400).json({ error: '请输入内容' });
  if (content.length > config.maxInputChars) {
    return res.status(400).json({ error: `单轮输入不能超过 ${config.maxInputChars} 字` });
  }

  // 防重复生成：同一会话只允许一个进行中的生成任务（防止前端重复提交/超时重发导致并发）
  if (getGen(s.id)?.generating) {
    return res.status(409).json({ error: '回复生成中，请稍候' });
  }

  // 建立会话级生成状态（内存态）。即使客户端连接被 OS 掐断，这里的 generating/draft
  // 仍持续更新，前端回前台后轮询该状态即可静默拿到完整回复——这是「生成与连接解耦」的关键。
  genState.set(s.id, { generating: true, draft: '', clientGone: false });
  const g = getGen(s.id);
  // 增量文本同时写入 draft（供恢复）与 SSE（仅当客户端仍在场，断开后静默丢弃推送但继续累积）
  const pushDelta = (text) => {
    if (!text) return;
    g.draft += text;
    if (!g.clientGone) {
      try {
        sseSend(res, { type: 'delta', text });
      } catch {
        // 往已断开的 socket 写失败：标记断开，但生成任务继续跑（不抛错中断上游）
        g.clientGone = true;
      }
    }
  };
  res.on('close', () => {
    g.clientGone = true;
  });

  const t0 = Date.now();
  const sid = s.id.slice(0, 8);
  let firstTokenMs = -1; // -1 表示未经过 LLM（走了关键词兜底）

  try {
    addMessage(s, 'user', content);

    const intent = resolvePostReportReply(s, content);
    let reply;
    let conversationJustReady = false;

    if (intent) {
      // 关键词兜底：不调 LLM，整段一次性下发
      reply = intent.reply;
      conversationJustReady = intent.justReady;
      firstTokenMs = Date.now() - t0;
      sseInit(res);
      pushDelta(reply);
    } else {
      const extraSystem =
        s.status === 'reported' && s.report
          ? `以下是已生成的报告全文，用户可能就报告内容追问：\n${s.report.markdown}`
          : '';
      sseInit(res);
      reply = await chatStream(chatSysPrompt, s.messages, {
        extraSystem,
        onDelta: (text) => {
          if (!text) return;
          if (firstTokenMs < 0) firstTokenMs = Date.now() - t0;
          pushDelta(text);
        },
      });
    }

    addMessage(s, 'assistant', reply);

    if (s.status === 'reported') {
      s.postReportTurns += 1;
      persist(s);
    }

    sseSend(res, {
      type: 'done',
      reply,
      conversationReady: !!s.conversationReady,
      conversationJustReady,
      postReportTurnsLeft: Math.max(0, config.postReportTurns - s.postReportTurns),
    });
    res.end();

    console.log(
      `[chat-stream] sid=${sid} turns=${s.messages.length} promptChars=${chatSysPrompt.length} firstTokenMs=${firstTokenMs} totalMs=${Date.now() - t0} chars=${(reply || '').length}`
    );
  } catch (e) {
    console.error(`[chat-stream] 失败 sid=${sid} totalMs=${Date.now() - t0} err=${e?.message || e}`);
    if (res.headersSent) {
      // 流已开启，不能再改状态码，只能下发 error 帧
      try {
        sseSend(res, { type: 'error', message: `模型调用失败：${e.message || e}` });
      } catch {
        /* 客户端已断开，忽略 */
      }
      try {
        res.end();
      } catch {
        /* 客户端已断开，忽略 */
      }
    } else {
      res.status(502).json({ error: `模型调用失败：${e.message || e}` });
    }
  } finally {
    // 无论成功/失败/客户端断开，生成任务在此标记为结束，前端轮询将看到 generating=false
    genState.delete(s.id);
  }
});

app.post('/api/session/:id/report', requireAuth, async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: '会话不存在' });
  if (!assertOwner(req, s, res)) return;
  if (s.status !== 'collecting') {
    return res.status(400).json({ error: '报告已生成，不能重复生成' });
  }

  const tStart = Date.now();
  try {
    let markdown;
    if (isMock()) {
      markdown = mockReport();
    } else {
      const instruction = buildReportInstruction(s.referencer);
      markdown = await chat(sysPrompt, s.messages, { extraSystem: instruction, temperature: 0.6 });
    }
    const html = renderReportHtml(markdown);
    setReport(s, markdown, html); // 持久化报告正文 HTML，供刷新恢复后报告页直接渲染
    // 报告生成后，AI 在对话框内追加追问：是否需要整理对话为 HTML 下载
    addMessage(s, 'assistant', CONVERSATION_FOLLOWUP);
    res.json({ reportHtml: html, reportMarkdown: markdown, followup: CONVERSATION_FOLLOWUP });
    console.log(
      `[report] sid=${s.id.slice(0, 8)} promptChars=${sysPrompt.length} totalMs=${Date.now() - tStart} chars=${(markdown || '').length}`
    );
  } catch (e) {
    console.error(
      `[report] 失败 sid=${s.id.slice(0, 8)} totalMs=${Date.now() - tStart} err=${e?.message || e}`
    );
    res.status(502).json({ error: `报告生成失败：${e.message || e}` });
  }
});

// 流式报告（P1）：报告输出最长，流式收益最大
app.post('/api/session/:id/report/stream', requireAuth, async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: '会话不存在' });
  if (!assertOwner(req, s, res)) return;
  if (s.status !== 'collecting') {
    return res.status(400).json({ error: '报告已生成，不能重复生成' });
  }

  // 防重复生成：同一会话只允许一个进行中的生成任务
  if (getGen(s.id)?.generating) {
    return res.status(409).json({ error: '报告生成中，请稍候' });
  }

  // 建立会话级生成状态（内存态，与对话流共用同一条记录）。即便客户端连接被 OS 掐断，
  // 报告生成任务仍继续跑，前端回前台后轮询即可静默拿到完整报告。
  genState.set(s.id, { generating: true, draft: '', clientGone: false });
  const g = getGen(s.id);
  const pushDelta = (text) => {
    if (!text) return;
    g.draft += text;
    if (!g.clientGone) {
      try {
        sseSend(res, { type: 'delta', text });
      } catch {
        g.clientGone = true;
      }
    }
  };
  res.on('close', () => {
    g.clientGone = true;
  });

  const t0 = Date.now();
  const sid = s.id.slice(0, 8);
  let firstTokenMs = -1;

  try {
    sseInit(res);
    let markdown;

    if (isMock()) {
      markdown = mockReport();
      // mock 模式同样逐段下发，便于本地验证前端增量渲染
      const step = 120;
      for (let i = 0; i < markdown.length; i += step) {
        if (firstTokenMs < 0) firstTokenMs = Date.now() - t0;
        pushDelta(markdown.slice(i, i + step));
        await new Promise((r) => setTimeout(r, 20));
      }
    } else {
      const instruction = buildReportInstruction(s.referencer);
      markdown = await chatStream(sysPrompt, s.messages, {
        extraSystem: instruction,
        temperature: 0.6,
        onDelta: (text) => {
          if (!text) return;
          if (firstTokenMs < 0) firstTokenMs = Date.now() - t0;
          pushDelta(text);
        },
      });
    }

    const html = renderReportHtml(markdown);
    setReport(s, markdown, html); // 持久化报告正文 HTML，供刷新恢复后报告页直接渲染
    addMessage(s, 'assistant', CONVERSATION_FOLLOWUP);

    sseSend(res, {
      type: 'done',
      reportHtml: html,
      reportMarkdown: markdown,
      followup: CONVERSATION_FOLLOWUP,
    });
    res.end();

    console.log(
      `[report-stream] sid=${sid} promptChars=${sysPrompt.length} firstTokenMs=${firstTokenMs} totalMs=${Date.now() - t0} chars=${(markdown || '').length}`
    );
  } catch (e) {
    console.error(`[report-stream] 失败 sid=${sid} totalMs=${Date.now() - t0} err=${e?.message || e}`);
    if (res.headersSent) {
      try {
        sseSend(res, { type: 'error', message: `报告生成失败：${e.message || e}` });
      } catch {
        /* 客户端已断开，忽略 */
      }
      try {
        res.end();
      } catch {
        /* 客户端已断开，忽略 */
      }
    } else {
      res.status(502).json({ error: `报告生成失败：${e.message || e}` });
    }
  } finally {
    // 无论成功/失败/客户端断开，生成任务在此标记为结束
    genState.delete(s.id);
  }
});

// 下载「对话整理 HTML」（替换原报告 HTML 下载；需登录 + 会话归属）
app.get('/api/session/:id/conversation/download', requireAuth, (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: '会话不存在' });
  if (!assertOwner(req, s, res)) return;
  if (!s.conversationReady || !s.conversationFile) {
    return res.status(404).json({ error: '暂无可下载的报告文件，请先回复是否需要整理对话' });
  }
  // 守卫：只发送真实存在、非空的文件，避免把历史残留/空壳文件当成报告下载
  if (
    !fs.existsSync(s.conversationFile) ||
    !fs.statSync(s.conversationFile).isFile() ||
    fs.statSync(s.conversationFile).size < 500
  ) {
    return res.status(404).json({ error: '报告文件已失效，请重新回复「需要」以生成' });
  }
  const fileName = path.basename(s.conversationFile);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
  res.sendFile(s.conversationFile);
});

// 仅当作为主模块直接运行时监听（测试时由测试框架导入 app，不自动监听）
// 关键：必须以「脚本自身真实位置」为基准解析 argv[1]，不能依赖 process.cwd()。
// 否则 PM2 托管时 worker 的 cwd 并非项目根，pathToFileURL(argv[1]) 会解析出错误路径，
// 导致 isMain 误判为 false、app.listen 永不执行（表现为 pm2 online 但端口不监听）。
const scriptDir = path.dirname(fileURLToPath(import.meta.url)); // 本文件目录，如 /opt/compass/server/src
const projectRoot = path.dirname(scriptDir); // 项目根，如 /opt/compass/server
const isMain =
  !!process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(projectRoot, process.argv[1])).href;
// 双保险：PM2 托管时直接监听（由 PM2 守护，不依赖 isMain 判定）
const underPM2 = !!process.env.PM2_HOME || process.env.pm_id !== undefined;
if (isMain || underPM2) {
  // 监听地址：默认 '0.0.0.0'（监听所有网卡），方便备案前用 http://公网IP:3001 临时访问/测试。
  // 生产环境（Nginx 反代就位、域名 HTTPS 上线后）建议设 LISTEN_HOST=127.0.0.1，
  // 仅允许本机 Nginx 访问，避免 3001 端口直连公网。
  const listenHost = process.env.LISTEN_HOST || '0.0.0.0';
  app.listen(config.port, listenHost, () => {
    console.log(`[hemo-career-compass] server on http://${listenHost}:${config.port}  (mock=${isMock()})`);
  });
}

export { app };
