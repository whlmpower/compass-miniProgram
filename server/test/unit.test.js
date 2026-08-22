import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';

// 清理测试数据文件
function cleanData() {
  const dir = path.join(config.rootDir, 'data');
  for (const f of ['users.json', 'ratelimit.json', 'sessions.json']) {
    try { fs.unlinkSync(path.join(dir, f)); } catch {}
  }
  try {
    for (const f of fs.readdirSync(path.join(dir, 'reports'))) {
      fs.unlinkSync(path.join(dir, 'reports', f));
    }
  } catch {}
}

// ---------- auth.js ----------
import { hashPassword, verifyPassword, signToken, verifyToken } from '../src/auth.js';

describe('auth.js', () => {
  describe('hashPassword / verifyPassword', () => {
    it('哈希后可通过明文校验', () => {
      const { salt, hash } = hashPassword('testPass123');
      assert.ok(salt.length > 0);
      assert.ok(hash.length > 0);
      assert.equal(verifyPassword('testPass123', hash, salt), true);
    });

    it('错误密码校验失败', () => {
      const { salt, hash } = hashPassword('correct');
      assert.equal(verifyPassword('wrong', hash, salt), false);
    });

    it('空哈希返回 false', () => {
      assert.equal(verifyPassword('x', '', ''), false);
    });
  });

  describe('signToken / verifyToken', () => {
    it('签发并验证合法 token', () => {
      const token = signToken({ phone: '13800000001', role: 'admin' });
      const payload = verifyToken(token);
      assert.equal(payload.phone, '13800000001');
      assert.equal(payload.role, 'admin');
      assert.ok(payload.exp > payload.iat);
    });

    it('篡改后的 token 验证失败', () => {
      const token = signToken({ phone: '13800000001', role: 'admin' });
      const tampered = token.slice(0, -4) + 'AAAA';
      assert.throws(() => verifyToken(tampered));
    });

    it('格式错误的 token 抛异常', () => {
      assert.throws(() => verifyToken('not.a.valid'));
      assert.throws(() => verifyToken('only-two-parts'));
    });

    it('非字符串参数抛异常', () => {
      assert.throws(() => verifyToken(null));
      assert.throws(() => verifyToken(123));
    });
  });
});

// ---------- captcha.js ----------
import { generateCaptcha, verifyCaptcha } from '../src/captcha.js';

describe('captcha.js', () => {
  it('generateCaptcha 返回 captchaId 和 SVG', () => {
    const { captchaId, svg } = generateCaptcha();
    assert.ok(captchaId);
    assert.ok(svg.includes('<svg'));
    assert.ok(svg.includes('</svg>'));
  });

  it('可从 SVG 中提取答案并验证', () => {
    const { captchaId, svg } = generateCaptcha();
    const chars = [...svg.matchAll(/<text[^>]*>(.)<\/text>/g)].map((m) => m[1]);
    const answer = chars.join('');
    assert.equal(answer.length, 4);
    assert.equal(verifyCaptcha(captchaId, answer), true);
  });

  it('错误答案验证失败', () => {
    const { captchaId } = generateCaptcha();
    assert.equal(verifyCaptcha(captchaId, 'XXXX'), false);
  });

  it('验证成功后一次性消费，不可重放', () => {
    const { captchaId, svg } = generateCaptcha();
    const chars = [...svg.matchAll(/<text[^>]*>(.)<\/text>/g)].map((m) => m[1]);
    const answer = chars.join('');
    assert.equal(verifyCaptcha(captchaId, answer), true);
    assert.equal(verifyCaptcha(captchaId, answer), false);
  });

  it('大小写不敏感', () => {
    const { captchaId, svg } = generateCaptcha();
    const chars = [...svg.matchAll(/<text[^>]*>(.)<\/text>/g)].map((m) => m[1]);
    const answer = chars.join('');
    assert.equal(verifyCaptcha(captchaId, answer.toLowerCase()), true);
  });
});

// ---------- users.js ----------
import { initAdmin, createUser, authenticate, listUsers, statusOf } from '../src/users.js';

describe('users.js', () => {
  beforeEach(() => cleanData());

  it('createUser 生成的密码符合规格（10 位、1 数字 9 字母、无歧义）', () => {
    initAdmin();
    const result = createUser('13900000001');
    const pwd = result.password;
    assert.equal(pwd.length, 10, '密码长度必须为 10');
    assert.ok(/\d/.test(pwd), '密码必须含数字');
    assert.ok(!/[0O1lI]/.test(pwd), '密码不能含歧义字符 0/O/1/l/I');
    assert.equal(pwd.replace(/\d/g, '').length, 9, '去掉数字后应剩 9 个字母');
  });

  it('authenticate 成功验证普通用户', () => {
    initAdmin();
    const result = createUser('13900000002');
    const auth = authenticate('13900000002', result.password);
    assert.equal(auth.ok, true);
    assert.equal(auth.role, 'user');
  });

  it('authenticate 拒绝错误密码', () => {
    initAdmin();
    createUser('13900000003');
    assert.equal(authenticate('13900000003', 'wrong').ok, false);
  });

  it('authenticate 拒绝不存在的用户', () => {
    initAdmin();
    assert.equal(authenticate('13999999999', 'x').ok, false);
  });

  it('authenticate 验证管理员', () => {
    cleanData();
    initAdmin();
    const auth = authenticate(config.adminPhone, config.adminPassword);
    assert.equal(auth.ok, true);
    assert.equal(auth.role, 'admin');
  });

  it('statusOf 返回正确状态', () => {
    assert.equal(statusOf({ revoked: true }), 'revoked');
    assert.equal(statusOf({ revoked: false, expiresAt: Date.now() - 1, usedAt: null }), 'expired');
    assert.equal(statusOf({ revoked: false, expiresAt: Date.now() + 99999, usedAt: null }), 'unused');
    assert.equal(statusOf({ revoked: false, expiresAt: Date.now() + 99999, usedAt: 123 }), 'used');
  });
});

// ---------- ratelimit.js ----------
import { check, record, resetAll } from '../src/ratelimit.js';

describe('ratelimit.js', () => {
  beforeEach(() => resetAll());

  it('初始状态允许访问', () => {
    const r = check('13900000010', '192.168.1.1');
    assert.equal(r.allowed, true);
    assert.equal(r.phoneCount, 0);
  });

  it('record 后 check 计数增加', () => {
    record('13900000011', '192.168.1.2');
    const r = check('13900000011', '192.168.1.2');
    assert.equal(r.phoneCount, 1);
    assert.equal(r.ipCount, 1);
    assert.equal(r.allowed, true);
  });

  it('超过手机号限制后被拒绝', () => {
    const phone = '13900000012';
    const ip = '192.168.1.3';
    for (let i = 0; i < config.ratePhoneMax; i++) record(phone, ip);
    const r = check(phone, ip);
    assert.equal(r.allowed, false, '达到限制后应被拒绝');
  });

  it('IP 维度独立计数', () => {
    record('13900000020', '192.168.1.100');
    record('13900000021', '192.168.1.100');
    const r = check('13900000022', '192.168.1.100');
    assert.equal(r.ipCount, 2);
    assert.equal(r.phoneCount, 0);
    assert.equal(r.allowed, true);
  });
});
