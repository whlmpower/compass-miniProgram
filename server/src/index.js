import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { config, isMock } from './config.js';
import { buildSystemPrompt, buildReportInstruction, listReferencers } from './skillLoader.js';
import { chat, mockReport } from './llm.js';
import { renderReportHtml } from './report.js';
import {
  createSession,
  getSession,
  addMessage,
  setReport,
  persist,
} from './store.js';
import { requireAuth, requireAdmin, signToken, getClientIp } from './auth.js';
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

const app = express();
app.set('trust proxy', true); // 取 X-Forwarded-For 第一段作为客户端 IP
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// 静态资源：H5 前端（报告仅通过鉴权接口下载，不在此公开挂载）
app.use(express.static(path.join(config.rootDir, '..', 'web')));

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
  res.json({ token, role: result.role });
});

// 当前登录身份（供前端校验 token / 渲染角色）
app.get('/api/me', requireAuth, (req, res) => {
  res.json({ phone: req.user.phone, role: req.user.role });
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
    res.status(500).json({ error: String(e.message || e) });
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
app.post('/api/session', requireAuth, async (req, res) => {
  try {
    const referencer = req.body?.referencer || 'general';
    const s = createSession(referencer);
    const greeting = await chat(sysPrompt, []);
    addMessage(s, 'assistant', greeting);
    res.json({ sessionId: s.id, greeting, config: publicConfig() });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/api/session/:id', requireAuth, (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: '会话不存在' });
  res.json({
    status: s.status,
    postReportTurns: s.postReportTurns,
    postReportTurnsLeft: Math.max(0, config.postReportTurns - s.postReportTurns),
    referencer: s.referencer,
    reportReady: !!s.report,
    messageCount: s.messages.length,
    messages: s.messages,
  });
});

app.post('/api/session/:id/message', requireAuth, async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: '会话不存在' });

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
    const extraSystem =
      s.status === 'reported' && s.report
        ? `以下是已生成的报告全文，用户可能就报告内容追问：\n${s.report.markdown}`
        : '';
    const reply = await chat(sysPrompt, s.messages, { extraSystem });
    addMessage(s, 'assistant', reply);
    if (s.status === 'reported') {
      s.postReportTurns += 1;
      persist(s);
    }
    res.json({
      reply,
      postReportTurnsLeft: Math.max(0, config.postReportTurns - s.postReportTurns),
    });
  } catch (e) {
    res.status(502).json({ error: `模型调用失败：${e.message || e}` });
  }
});

app.post('/api/session/:id/report', requireAuth, async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: '会话不存在' });
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
    setReport(s, markdown, html);
    res.json({ reportHtml: html, reportMarkdown: markdown });
  } catch (e) {
    res.status(502).json({ error: `报告生成失败：${e.message || e}` });
  }
});

// 下载报告（v2 已移除广告闸门，登录用户直接下载）
app.get('/api/session/:id/report/download', requireAuth, (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: '会话不存在' });
  if (!s.report) return res.status(404).json({ error: '报告尚未生成' });
  res.sendFile(path.join(config.reportsDir, `${s.id}.html`));
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
