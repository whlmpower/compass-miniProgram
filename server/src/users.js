import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { hashPassword, verifyPassword } from './auth.js';

// ---------- 持久化 ----------
function ensureDir() {
  fs.mkdirSync(path.dirname(config.usersFile), { recursive: true });
}

function load() {
  ensureDir();
  try {
    return JSON.parse(fs.readFileSync(config.usersFile, 'utf8'));
  } catch {
    return { users: [], admin: null };
  }
}

function save(data) {
  ensureDir();
  fs.writeFileSync(config.usersFile, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// ---------- 密码生成（10 位：1 数字 + 9 字母，排除歧义字符） ----------
const DIGITS = '23456789'; // 排除 0、1
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz'; // 排除 I、O、l

function generatePassword() {
  const arr = new Array(10).fill(null);
  const digitPos = Math.floor(Math.random() * 10);
  arr[digitPos] = DIGITS[Math.floor(Math.random() * DIGITS.length)];
  for (let i = 0; i < 10; i++) {
    if (arr[i] === null) arr[i] = LETTERS[Math.floor(Math.random() * LETTERS.length)];
  }
  // Fisher–Yates 洗牌，打散数字位置
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join('');
}

// ---------- 初始化管理员（首次启动从 .env 写入） ----------
export function initAdmin() {
  const data = load();
  if (data.admin) return;
  if (!config.adminPhone || !config.adminPassword) {
    // 未配置管理员凭据：跳过（admin 接口将 403）
    return;
  }
  const { salt, hash } = hashPassword(config.adminPassword);
  data.admin = { phone: config.adminPhone, pwdSalt: salt, pwdHash: hash };
  save(data);
}

export function getAdmin() {
  return load().admin;
}

// ---------- 用户 CRUD ----------
export function getUser(phone) {
  const data = load();
  return data.users.find((u) => u.phone === phone);
}

export function createUser(phone) {
  const data = load();
  const password = generatePassword();
  const { salt, hash } = hashPassword(password);
  const now = Date.now();
  const rec = {
    phone,
    pwdSalt: salt,
    pwdHash: hash,
    createdAt: now,
    expiresAt: now + config.userPwdTtlHours * 3600 * 1000,
    usedAt: null,
    revoked: false,
  };
  const idx = data.users.findIndex((u) => u.phone === phone);
  if (idx >= 0) data.users[idx] = rec;
  else data.users.push(rec);
  save(data);
  return { phone, password, expiresAt: rec.expiresAt, createdAt: now, status: 'unused' };
}

export function resetPassword(phone) {
  const data = load();
  const idx = data.users.findIndex((u) => u.phone === phone);
  if (idx < 0) return null;
  const password = generatePassword();
  const { salt, hash } = hashPassword(password);
  const now = Date.now();
  data.users[idx] = {
    ...data.users[idx],
    pwdSalt: salt,
    pwdHash: hash,
    createdAt: now,
    expiresAt: now + config.userPwdTtlHours * 3600 * 1000,
    usedAt: null,
    revoked: false,
  };
  save(data);
  const rec = data.users[idx];
  return { phone, password, expiresAt: rec.expiresAt, createdAt: now, status: 'unused' };
}

export function revokeUser(phone) {
  const data = load();
  const u = data.users.find((x) => x.phone === phone);
  if (!u) return false;
  u.revoked = true;
  save(data);
  return true;
}

export function changeAdminPassword(oldPwd, newPwd) {
  const data = load();
  if (!data.admin) return false;
  if (!verifyPassword(oldPwd, data.admin.pwdHash, data.admin.pwdSalt)) return false;
  const { salt, hash } = hashPassword(newPwd);
  data.admin.pwdSalt = salt;
  data.admin.pwdHash = hash;
  save(data);
  return true;
}

// ---------- 鉴权 ----------
export function authenticate(phone, password) {
  // 管理员
  const admin = getAdmin();
  if (admin && admin.phone === phone && verifyPassword(password, admin.pwdHash, admin.pwdSalt)) {
    return { ok: true, role: 'admin' };
  }
  // 普通用户
  const u = getUser(phone);
  if (!u) return { ok: false, reason: 'notfound' };
  if (u.revoked) return { ok: false, reason: 'revoked' };
  if (Date.now() > u.expiresAt) return { ok: false, reason: 'expired' };
  if (!verifyPassword(password, u.pwdHash, u.pwdSalt)) return { ok: false, reason: 'badpw' };
  u.usedAt = Date.now();
  const data = load();
  const idx = data.users.findIndex((x) => x.phone === phone);
  if (idx >= 0) data.users[idx] = u;
  save(data);
  return { ok: true, role: 'user' };
}

// ---------- 列表（含状态） ----------
export function statusOf(u, now = Date.now()) {
  if (u.revoked) return 'revoked';
  if (now > u.expiresAt) return 'expired';
  if (u.usedAt == null) return 'unused';
  return 'used';
}

export function maskPhone(phone) {
  if (!phone || phone.length < 7) return phone;
  return phone.slice(0, 3) + '****' + phone.slice(7);
}

export function listUsers() {
  const data = load();
  const now = Date.now();
  return data.users.map((u) => ({
    phone: u.phone,
    phoneMasked: maskPhone(u.phone),
    status: statusOf(u, now),
    createdAt: u.createdAt,
    expiresAt: u.expiresAt,
    usedAt: u.usedAt,
  }));
}
