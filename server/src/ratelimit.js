import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// 滑动窗口限流：以 (维度, key) 为索引存失败时间戳
// 仅「手机号或密码错误」计数；图形验证码错误不计数
const WINDOW = config.rateWindowHours * 3600 * 1000;
const byPhone = new Map();
const byIp = new Map();

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(config.ratelimitFile, 'utf8'));
    for (const [k, v] of Object.entries(d.byPhone || {})) byPhone.set(k, v);
    for (const [k, v] of Object.entries(d.byIp || {})) byIp.set(k, v);
  } catch {
    /* 无持久化文件 */
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(config.ratelimitFile), { recursive: true });
    fs.writeFileSync(
      config.ratelimitFile,
      JSON.stringify({ byPhone: Object.fromEntries(byPhone), byIp: Object.fromEntries(byIp) })
    );
  } catch {
    /* 忽略写入失败 */
  }
}

function within(arr) {
  const cutoff = Date.now() - WINDOW;
  return (arr || []).filter((t) => t > cutoff);
}

export function check(phone, ip) {
  const phoneCount = within(byPhone.get(phone)).length;
  const ipCount = within(byIp.get(ip)).length;
  return {
    phoneCount,
    ipCount,
    allowed: phoneCount < config.ratePhoneMax && ipCount < config.rateIpMax,
  };
}

export function record(phone, ip) {
  const now = Date.now();
  byPhone.set(phone, within(byPhone.get(phone)).concat(now));
  byIp.set(ip, within(byIp.get(ip)).concat(now));
  persist();
}

// 测试用：重置内存状态
export function resetAll() {
  byPhone.clear();
  byIp.clear();
  persist();
}

load();
