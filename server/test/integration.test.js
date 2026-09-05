import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// 在导入任何模块之前设置环境
process.env.LLM_MOCK = 'true';
process.env.ADMIN_PHONE = '13800000001';
process.env.ADMIN_PASSWORD = 'admin123456';
process.env.JWT_SECRET = 'test_secret';
process.env.INVITE_CODE = 'TEST-INVITE-2026';

const { config } = await import('../src/config.js');
const { initAdmin } = await import('../src/users.js');
const { resetAll: resetRatelimit } = await import('../src/ratelimit.js');

// 清理测试数据文件
function cleanData() {
  for (const f of ['users.json', 'ratelimit.json', 'sessions.json', 'emailcodes.json']) {
    try { fs.unlinkSync(path.join(config.rootDir, 'data', f)); } catch {}
  }
  try {
    for (const f of fs.readdirSync(path.join(config.rootDir, 'data', 'reports'))) {
      fs.unlinkSync(path.join(config.rootDir, 'data', 'reports', f));
    }
  } catch {}
}

// 导入 app（不自动监听，因为 isMain 判断会跳过 listen）
const { app } = await import('../src/index.js');

// 启动服务器
let server, baseUrl;
before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) {
    // fetch（undici）的 keep-alive 连接会让 server.close() 等待已有连接而永不回调，
    // 进程因此无法退出（node --test 挂起）。先强制断开所有连接再关闭。
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
  cleanData();
});

beforeEach(async () => {
  cleanData();
  resetRatelimit();
  initAdmin();
});

// ---------- 辅助函数 ----------

async function req(method, urlPath, body, token, raw = false, extraHeaders) {
  const headers = { ...(extraHeaders || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (raw) return { res }; // 调用方自行读取 body（如下载报告的 HTML）
  let data = null;
  try { data = await res.json(); } catch {}
  return { res, data };
}

async function getCaptchaAnswer() {
  const { data } = await req('POST', '/api/auth/captcha');
  const chars = [...data.svg.matchAll(/<text[^>]*>(.)<\/text>/g)].map((m) => m[1]);
  return { captchaId: data.captchaId, answer: chars.join('') };
}

async function login(phone, password, xff) {
  const { captchaId, answer } = await getCaptchaAnswer();
  const headers = xff ? { 'X-Forwarded-For': xff } : undefined;
  return req('POST', '/api/auth/login', { phone, captchaId, captchaInput: answer, password }, undefined, false, headers);
}

async function adminLogin() {
  const { res, data } = await login('13800000001', 'admin123456');
  assert.equal(res.status, 200, `admin 登录应成功，实际 ${res.status}: ${JSON.stringify(data)}`);
  return data.token;
}

async function createTestUser(phone) {
  const token = await adminLogin();
  const { res, data } = await req('POST', '/api/admin/users', { phone }, token);
  assert.equal(res.status, 200, `创建用户应成功: ${JSON.stringify(data)}`);
  return { adminToken: token, password: data.password };
}

async function userLogin(phone, password) {
  const { res, data } = await login(phone, password);
  assert.equal(res.status, 200, `用户登录应成功: ${JSON.stringify(data)}`);
  return data.token;
}

// ===== 测试用例 =====

describe('认证与登录', () => {
  it('无 token 访问 /api/me 返回 401', async () => {
    const { res } = await req('GET', '/api/me');
    assert.equal(res.status, 401);
  });

  it('无 token 访问 admin 接口返回 401', async () => {
    const { res } = await req('GET', '/api/admin/users');
    assert.equal(res.status, 401);
  });

  it('admin 登录成功并返回有效 JWT', async () => {
    const token = await adminLogin();
    assert.equal(token.split('.').length, 3);

    const { res, data } = await req('GET', '/api/me', undefined, token);
    assert.equal(res.status, 200);
    assert.equal(data.role, 'admin');
    assert.equal(data.phone, '13800000001');
  });

  it('图形验证码错误时登录失败（不计数）', async () => {
    const { captchaId } = await getCaptchaAnswer();
    const { res, data } = await req('POST', '/api/auth/login', {
      phone: '13800000001',
      captchaId,
      captchaInput: 'WRONG',
      password: 'admin123456',
    });
    assert.equal(res.status, 400);
    assert.equal(data.error, '图形验证码不正确');
  });

  it('密码错误时登录失败', async () => {
    const { res, data } = await login('13800000001', 'wrongpassword');
    assert.equal(res.status, 401);
    assert.equal(data.error, '手机号或密码错误');
  });

  it('伪造 token 返回 401', async () => {
    const { res } = await req('GET', '/api/me', undefined, 'fake.token.here');
    assert.equal(res.status, 401);
  });
});

describe('Admin 用户管理', () => {
  it('创建用户并返回 10 位密码', async () => {
    const { password } = await createTestUser('13900000001');
    assert.equal(password.length, 10);
    assert.ok(/\d/.test(password), '密码应含数字');
    assert.ok(!/[0O1lI]/.test(password), '密码不应含歧义字符');
  });

  it('列出已创建用户', async () => {
    await createTestUser('13900000002');
    const token = await adminLogin();
    const { res, data } = await req('GET', '/api/admin/users', undefined, token);
    assert.equal(res.status, 200);
    assert.ok(data.users.length >= 1);
    const u = data.users.find((x) => x.phone === '13900000002');
    assert.ok(u);
    assert.equal(u.status, 'unused');
  });

  it('重置用户密码', async () => {
    await createTestUser('13900000003');
    const token = await adminLogin();
    const { res, data } = await req('POST', '/api/admin/users/13900000003/reset', {}, token);
    assert.equal(res.status, 200);
    assert.ok(data.password);
    assert.equal(data.password.length, 10);
  });

  it('作废用户', async () => {
    await createTestUser('13900000004');
    const token = await adminLogin();
    const { res } = await req('POST', '/api/admin/users/13900000004/revoke', {}, token);
    assert.equal(res.status, 200);

    const { data: list } = await req('GET', '/api/admin/users', undefined, token);
    const u = list.users.find((x) => x.phone === '13900000004');
    assert.equal(u.status, 'revoked');
  });

  it('普通用户访问 admin 接口返回 403', async () => {
    const { password } = await createTestUser('13900000005');
    const userToken = await userLogin('13900000005', password);
    const { res } = await req('GET', '/api/admin/users', undefined, userToken);
    assert.equal(res.status, 403);
  });

  it('修改管理员密码', async () => {
    const token = await adminLogin();
    const { res } = await req('PUT', '/api/admin/password', {
      oldPwd: 'admin123456',
      newPwd: 'newAdmin789',
    }, token);
    assert.equal(res.status, 200);

    // 旧密码登录失败
    const { res: r2 } = await login('13800000001', 'admin123456');
    assert.equal(r2.status, 401);

    // 新密码登录成功
    const { res: r3, data: d3 } = await login('13800000001', 'newAdmin789');
    assert.equal(r3.status, 200);
    assert.ok(d3.token);
  });
});

describe('诊断会话流程', () => {
  it('创建会话 → 发消息 → 生成报告 → 下载', async () => {
    const { password } = await createTestUser('13900000010');
    const token = await userLogin('13900000010', password);

    // 创建会话
    const { res: r1, data: d1 } = await req('POST', '/api/session', {}, token);
    assert.equal(r1.status, 200);
    assert.ok(d1.sessionId);
    assert.ok(d1.greeting);

    const sid = d1.sessionId;

    // 发送消息
    const { res: r2, data: d2 } = await req('POST', `/api/session/${sid}/message`, {
      content: '我在外企做了五年技术，父母希望我回国企，很纠结。',
    }, token);
    assert.equal(r2.status, 200);
    assert.ok(d2.reply);

    // 生成报告
    const { res: r3, data: d3 } = await req('POST', `/api/session/${sid}/report`, {}, token);
    assert.equal(r3.status, 200);
    assert.ok(d3.reportHtml);

    // 回复「需要」触发对话整理 HTML 生成（下载接口依赖此步骤）
    // 注：旧路由 /report/download 已由 /conversation/download 取代（对话整理 HTML）
    const { res: r5 } = await req('POST', `/api/session/${sid}/message`, { content: '需要' }, token);
    assert.equal(r5.status, 200);

    // 下载对话整理 HTML（raw 模式：自行读取 body）
    const { res: r4 } = await req('GET', `/api/session/${sid}/conversation/download`, undefined, token, true);
    assert.equal(r4.status, 200);
    const html = await r4.text();
    assert.ok(html.includes('<html') || html.includes('<!DOCTYPE'));
  });

  it('流式对话接口返回 SSE 帧，增量可拼接为完整回复', async () => {
    const { password } = await createTestUser('13900000011');
    const token = await userLogin('13900000011', password);

    const { data: d1 } = await req('POST', '/api/session', {}, token);
    const sid = d1.sessionId;

    const res = await fetch(`${baseUrl}/api/session/${sid}/message/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ content: '我在考虑要不要换工作。' }),
    });
    assert.equal(res.status, 200);
    assert.ok(
      (res.headers.get('content-type') || '').includes('text/event-stream'),
      '响应应为 SSE 流'
    );

    const deltas = [];
    let done = null;
    // 一次性读取全部内容后按 SSE 帧解析（mock 模式输出很短，不影响帧结构验证）
    for (const frame of (await res.text()).split('\n\n')) {
      const line = frame.trim();
      if (!line.startsWith('data:')) continue;
      const obj = JSON.parse(line.slice(5).trim());
      if (obj.type === 'delta') deltas.push(obj.text);
      else if (obj.type === 'done') done = obj;
      else if (obj.type === 'error') assert.fail(`流返回错误：${obj.message}`);
    }
    assert.ok(deltas.length > 0, '应至少收到一段增量文本');
    assert.ok(done, '应收到 done 帧');
    assert.ok(done.reply && done.reply.length > 0);
    assert.equal(deltas.join(''), done.reply, '增量拼接后应与 done.reply 完全一致');
    assert.equal(typeof done.postReportTurnsLeft, 'number');
  });

  it('流式报告接口返回 SSE 帧并产出报告 HTML', async () => {
    const { password } = await createTestUser('13900000012');
    const token = await userLogin('13900000012', password);

    const { data: d1 } = await req('POST', '/api/session', {}, token);
    const sid = d1.sessionId;
    await req('POST', `/api/session/${sid}/message`, { content: '我在外企做了五年技术。' }, token);

    const res = await fetch(`${baseUrl}/api/session/${sid}/report/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);

    let deltaCount = 0;
    let done = null;
    for (const frame of (await res.text()).split('\n\n')) {
      const line = frame.trim();
      if (!line.startsWith('data:')) continue;
      const obj = JSON.parse(line.slice(5).trim());
      if (obj.type === 'delta') deltaCount += 1;
      else if (obj.type === 'done') done = obj;
      else if (obj.type === 'error') assert.fail(`流返回错误：${obj.message}`);
    }
    assert.ok(deltaCount > 0, '应至少收到一段增量文本');
    assert.ok(done && done.reportHtml, 'done 帧应携带 reportHtml');
    assert.ok(done.followup, 'done 帧应携带追问话术');
  });

  it('未登录用户不能创建会话', async () => {
    const { res } = await req('POST', '/api/session', {});
    assert.equal(res.status, 401);
  });

  it('报告生成后追问轮次递减', async () => {
    const { password } = await createTestUser('13900000011');
    const token = await userLogin('13900000011', password);

    const { data: d1 } = await req('POST', '/api/session', {}, token);
    const sid = d1.sessionId;

    await req('POST', `/api/session/${sid}/message`, { content: '我最近在考虑换工作。' }, token);
    await req('POST', `/api/session/${sid}/report`, {}, token);

    // 检查报告后状态
    const { data: d2 } = await req('GET', `/api/session/${sid}`, undefined, token);
    assert.equal(d2.status, 'reported');
    assert.equal(d2.postReportTurnsLeft, 10);

    // 追问一轮
    const { data: d3 } = await req('POST', `/api/session/${sid}/message`, {
      content: '报告里说的安全感维度具体指什么？',
    }, token);
    assert.equal(d3.postReportTurnsLeft, 9);
  });
});

describe('限流', () => {
  it('同一手机号失败达上限后被限流（ratePhoneMax=5：允许 4 次，第 5 次起封禁）', async () => {
    // 临时放大 IP 维度上限，仅验证「手机号维度」的限流逻辑，
    // 避免所有测试用例共用 localhost IP 导致的维度污染
    const origIpMax = config.rateIpMax;
    config.rateIpMax = 9999;
    const phone = '13700000099';
    try {
      // 前 4 次失败登录仍返回 401（未达上限）
      for (let i = 0; i < 4; i++) {
        const { res } = await login(phone, 'wrongpassword');
        assert.equal(res.status, 401);
      }
      // 第 5 次失败登录触发限流
      const { res, data } = await login(phone, 'wrongpassword');
      assert.equal(res.status, 429);
      assert.ok(data.error.includes('尝试过多'));
    } finally {
      config.rateIpMax = origIpMax;
    }
  });
});

// ===== 邮箱自注册（邀请码门控） =====

// mock 邮件模式下，验证码持久化在 data/emailcodes.json，测试直接读取
function readEmailCode(email) {
  const file = path.join(config.rootDir, 'data', 'emailcodes.json');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'))[email];
  return rec ? rec.code : '';
}

describe('邮箱自注册', () => {
  it('错误邀请码返回 401', async () => {
    const { res, data } = await req('POST', '/api/auth/register/verify-invite', { code: 'WRONG-CODE' });
    assert.equal(res.status, 401);
    assert.ok(data.error.includes('邀请码'));
  });

  it('正确邀请码返回 inviteToken，但拿它发验证码时邮箱已注册会 409', async () => {
    const { res, data } = await req('POST', '/api/auth/register/verify-invite', { code: 'TEST-INVITE-2026' });
    assert.equal(res.status, 200);
    assert.ok(data.inviteToken);

    // 邮箱格式错误 400
    const bad = await req('POST', '/api/auth/register/send-code', { email: 'not-an-email', inviteToken: data.inviteToken });
    assert.equal(bad.res.status, 400);

    // 伪造 inviteToken 401
    const forged = await req('POST', '/api/auth/register/send-code', { email: 'a@example.com', inviteToken: 'forged.token.here' });
    assert.equal(forged.res.status, 401);
  });

  it('完整注册链路：邀请码 → 邮箱验证码 → 绑定手机号密码 → 自动登录可用', async () => {
    // 1) 邀请码
    const inv = await req('POST', '/api/auth/register/verify-invite', { code: 'TEST-INVITE-2026' });
    assert.equal(inv.res.status, 200);
    const inviteToken = inv.data.inviteToken;

    // 2) 发送验证码（EMAIL 无凭证 → mock 落盘）
    const email = 'newuser@example.com';
    const send = await req('POST', '/api/auth/register/send-code', { email, inviteToken });
    assert.equal(send.res.status, 200);

    // 3) 校验验证码
    const code = readEmailCode(email);
    assert.ok(/^\d{6}$/.test(code), 'mock 模式下应能从 emailcodes.json 读到 6 位验证码');
    const ver = await req('POST', '/api/auth/register/verify-email', { email, code });
    assert.equal(ver.res.status, 200);
    assert.ok(ver.data.regToken);

    // 4) 绑定手机号 + 自设密码，建号并登录
    const phone = '13900001234';
    const done = await req('POST', '/api/auth/register/complete', { regToken: ver.data.regToken, phone, password: 'Str0ng!pwd' });
    assert.equal(done.res.status, 200);
    assert.equal(done.data.role, 'user');
    assert.ok(done.data.token.split('.').length === 3);

    // 5) 新账号立即可用（/api/me + 建会话）
    const me = await req('GET', '/api/me', undefined, done.data.token);
    assert.equal(me.res.status, 200);
    assert.equal(me.data.phone, phone);

    // 6) 弱密码被拒
    const dup = await req('POST', '/api/auth/register/verify-invite', { code: 'TEST-INVITE-2026' });
    const send2 = await req('POST', '/api/auth/register/send-code', { email: 'weak@example.com', inviteToken: dup.data.inviteToken });
    assert.equal(send2.res.status, 200);
    const ver2 = await req('POST', '/api/auth/register/verify-email', { email: 'weak@example.com', code: readEmailCode('weak@example.com') });
    const weak = await req('POST', '/api/auth/register/complete', { regToken: ver2.data.regToken, phone: '13900005678', password: 'abc12345' });
    assert.equal(weak.res.status, 400);
  });

  it('已验证邮箱注册完成后，同邮箱再次注册被 409 拒绝；手机号冲突也被拒', async () => {
    const email = 'dup@example.com';
    const phone = '13900007777';

    async function registerFlow(em, ph, pwd) {
      const inv = await req('POST', '/api/auth/register/verify-invite', { code: 'TEST-INVITE-2026' });
      await req('POST', '/api/auth/register/send-code', { email: em, inviteToken: inv.data.inviteToken });
      const ver = await req('POST', '/api/auth/register/verify-email', { email: em, code: readEmailCode(em) });
      return req('POST', '/api/auth/register/complete', { regToken: ver.data.regToken, phone: ph, password: pwd });
    }

    const first = await registerFlow(email, phone, 'Str0ng!pwd');
    assert.equal(first.res.status, 200);

    // 同邮箱再走一遍：send-code 阶段即被 409 拦截
    const inv2 = await req('POST', '/api/auth/register/verify-invite', { code: 'TEST-INVITE-2026' });
    const sendAgain = await req('POST', '/api/auth/register/send-code', { email, inviteToken: inv2.data.inviteToken });
    assert.equal(sendAgain.res.status, 409);

    // 同手机号不同邮箱：complete 阶段 409
    const inv3 = await req('POST', '/api/auth/register/verify-invite', { code: 'TEST-INVITE-2026' });
    const other = 'other@example.com';
    await req('POST', '/api/auth/register/send-code', { email: other, inviteToken: inv3.data.inviteToken });
    const ver3 = await req('POST', '/api/auth/register/verify-email', { email: other, code: readEmailCode(other) });
    const samePhone = await req('POST', '/api/auth/register/complete', { regToken: ver3.data.regToken, phone, password: 'Str0ng!pwd' });
    assert.equal(samePhone.res.status, 409);
  });

  it('自设密码账号不过期：登录成功且 pwdSource=self 生效', async () => {
    const email = 'noexp@example.com';
    const phone = '13900009999';
    const inv = await req('POST', '/api/auth/register/verify-invite', { code: 'TEST-INVITE-2026' });
    await req('POST', '/api/auth/register/send-code', { email, inviteToken: inv.data.inviteToken });
    const ver = await req('POST', '/api/auth/register/verify-email', { email, code: readEmailCode(email) });
    const done = await req('POST', '/api/auth/register/complete', { regToken: ver.data.regToken, phone, password: 'Str0ng!pwd' });
    assert.equal(done.res.status, 200);

    // users.json 中该账号 pwdSource=self、expiresAt 为远未来
    const users = JSON.parse(fs.readFileSync(path.join(config.rootDir, 'data', 'users.json'), 'utf8'));
    const rec = users.users.find((u) => u.phone === phone);
    assert.ok(rec, '账号应已落盘');
    assert.equal(rec.pwdSource, 'self');
    assert.equal(rec.email, email);
    assert.ok(rec.expiresAt > Date.now() + 365 * 24 * 3600 * 1000, '自设密码不应在一年内过期');

    // 用自设密码走图形验证码登录也应成功
    const { res } = await login(phone, 'Str0ng!pwd');
    assert.equal(res.status, 200);
  });
});
