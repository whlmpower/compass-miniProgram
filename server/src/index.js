import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { config, isMock } from './config.js';
import { buildSystemPrompt, buildReportInstruction, listReferencers } from './skillLoader.js';
import { chat, mockReport } from './llm.js';
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
} from './users.js';
import { check, record } from './ratelimit.js';

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
const sysPrompt = buildSystemPrompt();

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
const REFUSE_REPLY = '好的，你还有其他问题吗？';

// 把「到报告生成为止」的对话渲染为 HTML 并落盘，记录路径
function generateConversation(s) {
  if (!s.report) return false;
  const preReport = s.messages.filter((m) => (m.ts || 0) <= s.report.generatedAt);
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
    const greeting = await chat(sysPrompt, []);
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
    conversationReady: !!s.conversationReady,
    messageCount: s.messages.length,
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

  try {
    addMessage(s, 'user', content);

    // 报告已生成、对话 HTML 尚未生成时：用关键词兜底识别用户意图（拦截式，不调用 LLM）
    let reply;
    let conversationJustReady = false;
    if (s.status === 'reported' && !s.conversationReady && wantsConversation(content)) {
      if (generateConversation(s)) conversationJustReady = true;
      reply = NEED_REPLY;
    } else if (s.status === 'reported' && refusesConversation(content)) {
      reply = REFUSE_REPLY;
    } else {
      const extraSystem =
        s.status === 'reported' && s.report
          ? `以下是已生成的报告全文，用户可能就报告内容追问：\n${s.report.markdown}`
          : '';
      reply = await chat(sysPrompt, s.messages, { extraSystem });
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
  } catch (e) {
    res.status(502).json({ error: `模型调用失败：${e.message || e}` });
  }
});

app.post('/api/session/:id/report', requireAuth, async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: '会话不存在' });
  if (!assertOwner(req, s, res)) return;
  if (s.status !== 'collecting') {
    return res.status(400).json({ error: '报告已生成，不能重复生成' });
  }

  try {
    let markdown;
    if (isMock()) {
      markdown = mockReport();
    } else {
      const instruction = buildReportInstruction(s.referencer);
      markdown = await chat(sysPrompt, s.messages, { extraSystem: instruction, temperature: 0.6 });
    }
    const html = renderReportHtml(markdown);
    setReport(s, markdown);
    // 报告生成后，AI 在对话框内追加追问：是否需要整理对话为 HTML 下载
    addMessage(s, 'assistant', CONVERSATION_FOLLOWUP);
    res.json({ reportHtml: html, reportMarkdown: markdown, followup: CONVERSATION_FOLLOWUP });
  } catch (e) {
    res.status(502).json({ error: `报告生成失败：${e.message || e}` });
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
  const fileName = path.basename(s.conversationFile);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
  res.sendFile(s.conversationFile);
});

// 仅当作为主模块直接运行时监听（测试时由测试框架导入 app，不自动监听）
const isMain =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  app.listen(config.port, () => {
    console.log(`[hemo-career-compass] server on http://localhost:${config.port}  (mock=${isMock()})`);
  });
}

export { app };
