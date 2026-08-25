import crypto from 'node:crypto';
import { config } from './config.js';

// ---------- 密码哈希（scrypt，零依赖） ----------
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

export function verifyPassword(password, hashHex, saltHex) {
  if (!hashHex || !saltHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), salt, 64);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// ---------- JWT（HS256，手写，零依赖） ----------
function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function hmac(input) {
  return crypto.createHmac('sha256', config.jwtSecret).update(input).digest('base64url');
}

export function signToken({ phone, role }) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    phone,
    role,
    iat: now,
    exp: now + config.jwtExpiresHours * 3600,
  };
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  return `${signingInput}.${hmac(signingInput)}`;
}

export function verifyToken(token) {
  if (typeof token !== 'string') throw new Error('invalid token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [h, p, s] = parts;
  const expected = hmac(`${h}.${p}`);
  const sigBuf = Buffer.from(s, 'base64url');
  const expBuf = Buffer.from(expected, 'base64url');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new Error('bad signature');
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    throw new Error('malformed payload');
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp < now) {
    throw new Error('token expired');
  }
  return payload;
}

// ---------- Cookie（httpOnly，承载 JWT，防 XSS 盗取） ----------
const COOKIE_NAME = 'hcc_token';

function parseCookies(req) {
  const h = req.headers.cookie;
  if (!h) return {};
  const out = {};
  for (const part of h.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function getCookie(req, name) {
  return parseCookies(req)[name] || '';
}

export function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    maxAge: config.jwtExpiresHours * 3600 * 1000,
    path: '/',
  });
}

export function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/', secure: config.cookieSecure });
}

// ---------- 客户端 IP（受 trust proxy 配置约束） ----------
// 直接返回 req.ip：当 trust proxy=false 时为真实 socket 地址；
// 当 trust proxy 设为可信代理时，Express 已据 X-Forwarded-For 解析，
// 从而伪造 XFF 无法绕过 IP 限流。
export function getClientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// ---------- Express 中间件 ----------
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1] : getCookie(req, COOKIE_NAME);
  if (!token) return res.status(401).json({ error: '未登录' });
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    return res.status(401).json({ error: '登录已失效，请重新登录' });
  }
}

export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: '无权访问该资源' });
  }
  next();
}
