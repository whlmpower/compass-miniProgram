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

// ---------- 自注册账号（邮箱注册通道：邀请码 + 邮箱验证码验证后建号） ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// 自设密码强度：≥8 位，且同时含字母、数字、符号
const SELF_PWD_RE = /^(?=.*[a-zA-Z])(?=.*\d)(?=.*[^a-zA-Z0-9]).{8,}$/;

export function validateSelfPassword(pwd) {
  if (typeof pwd !== 'string' || pwd.length < 8) return { ok: false, error: '密码至少 8 位' };
  if (!SELF_PWD_RE.test(pwd)) return { ok: false, error: '密码需同时包含字母、数字和符号' };
  return { ok: true };
}

// 自注册建号：邮箱（经邀请码+邮箱验证码验证后传入）+ 自设手机号与密码。
// 校验格式与唯一性；密码永不过期（pwdSource='self'）。
export function createSelfAccount(phone, email, password) {
  const e = String(email || '').trim().toLowerCase();
  if (!/^1\d{10}$/.test(phone)) return { ok: false, error: '请输入正确的 11 位手机号' };
  if (!EMAIL_RE.test(e)) return { ok: false, error: '请输入正确的邮箱地址' };
  const v = validateSelfPassword(password);
  if (!v.ok) return v;
  if (getUser(phone)) return { ok: false, error: '该手机号已注册，请直接登录' };
  if (getUserByEmail(e)) return { ok: false, error: '该邮箱已注册' };
  const { salt, hash } = hashPassword(password);
  const now = Date.now();
  const rec = {
    phone,
    email: e,
    pwdSalt: salt,
    pwdHash: hash,
    pwdSource: 'self',
    createdAt: now,
    expiresAt: now + 36500 * 24 * 3600 * 1000, // 自设密码不过期（远未来兜底）
    usedAt: null,
    revoked: false,
  };
  const data = load();
  data.users.push(rec);
  save(data);
  return { ok: true, phone, email: e };
}

// ---------- 初始化/同步管理员：每次启动都按 .env 最新值刷新 ----------
// 设计：.env 是 admin 凭据的权威来源。只要配置了 ADMIN_PHONE/ADMIN_PASSWORD，
// 每次启动都确保 users.json 里的 admin 与 .env 一致（首次创建 / 改密码 / 改手机号时更新）。
// 未配置则保留现有记录（不创建、不删除），兼容「禁用 admin」的场景。
export function initAdmin() {
  if (!config.adminPhone || !config.adminPassword) return;
  const expected = hashPassword(config.adminPassword);
  const data = load();
  const existing = data.admin;
  const needUpdate =
    !existing ||
    existing.phone !== config.adminPhone ||
    existing.pwdHash !== expected.hash;
  if (!needUpdate) return; // 凭据未变，不无谓重写
  data.admin = { phone: config.adminPhone, pwdSalt: expected.salt, pwdHash: expected.hash };
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

export function getUserByEmail(email) {
  if (!email) return null;
  const data = load();
  return data.users.find((u) => u.email && u.email.toLowerCase() === String(email).toLowerCase());
}

export function createUser(phone) {
  const data = load();
  const password = generatePassword();
  const { salt, hash } = hashPassword(password);
  const now = Date.now();
  const rec = {
    phone,
    email: '',
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
  // 自设密码（pwdSource='self'）不过期；管理员下发的随机密码仍按 expiresAt 校验
  if (u.pwdSource !== 'self' && Date.now() > u.expiresAt) return { ok: false, reason: 'expired' };
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
