import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// 在导入任何模块之前设置环境
process.env.LLM_MOCK = 'true';
process.env.ADMIN_PHONE = '13800000001';
process.env.ADMIN_PASSWORD = 'admin123456';
process.env.JWT_SECRET = 'test_secret';

const { config } = await import('../src/config.js');
const { initAdmin } = await import('../src/users.js');
const { resetAll: resetRatelimit } = await import('../src/ratelimit.js');

// 清理测试数据文件
function cleanData() {
  for (const f of ['users.json', 'ratelimit.json', 'sessions.json']) {
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
  if (server) await new Promise((r) => server.close(r));
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

    // 下载报告（raw 模式：自行读取 body）
    const { res: r4 } = await req('GET', `/api/session/${sid}/report/download`, undefined, token, true);
    assert.equal(r4.status, 200);
    const html = await r4.text();
    assert.ok(html.includes('<html') || html.includes('<!DOCTYPE'));
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
