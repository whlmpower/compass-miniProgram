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

// ---------- 客户端 IP（考虑反向代理） ----------
export function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// ---------- Express 中间件 ----------
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ error: '未登录' });
  try {
    req.user = verifyToken(m[1]);
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
