import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const sessions = new Map();

function ensureDirs() {
  fs.mkdirSync(config.sessionsDir, { recursive: true });
  fs.mkdirSync(config.reportsDir, { recursive: true });
  fs.mkdirSync(config.conversationsDir, { recursive: true });
}

function loadAll() {
  ensureDirs();
  try {
    for (const f of fs.readdirSync(config.sessionsDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(config.sessionsDir, f), 'utf8'));
        sessions.set(s.id, s);
      } catch {
        /* corrupt file, ignore */
      }
    }
  } catch {
    /* empty */
  }
}

export function createSession(referencer = 'general', phone = null) {
  const id = crypto.randomUUID();
  const s = {
    id,
    phone, // 归属用户手机号（v2 鉴权后必填，用于恢复历史与会话隔离）
    createdAt: Date.now(),
    status: 'collecting', // collecting | reported
    referencer,
    messages: [],
    report: null,
    postReportTurns: 0,
    conversationFile: null, // 对话整理 HTML 路径（用户确认需要后生成）
    conversationReady: false,
  };
  sessions.set(id, s);
  persist(s);
  return s;
}

// 返回该用户最近一个「有效」会话：reported 会话在 reportTtlHours 内有效；
// collecting 会话在 abandonTtlDays 内有效。无则 null。
export function getLatestValidSessionForPhone(phone) {
  const now = Date.now();
  const ttl = config.reportTtlHours * 3600 * 1000;
  const abandonTtl = config.abandonTtlDays * 24 * 3600 * 1000;
  let best = null;
  for (const s of sessions.values()) {
    if (!phone || s.phone !== phone) continue;
    let valid;
    if (s.status === 'reported' && s.report) {
      valid = now - s.report.generatedAt <= ttl;
    } else {
      valid = now - s.createdAt <= abandonTtl;
    }
    if (!valid) continue;
    if (!best || s.createdAt > best.createdAt) best = s;
  }
  return best;
}

export function getSession(id) {
  return sessions.get(id);
}

export function persist(s) {
  fs.writeFileSync(path.join(config.sessionsDir, `${s.id}.json`), JSON.stringify(s), { mode: 0o600 });
}

export function addMessage(s, role, content) {
  s.messages.push({ role, content, ts: Date.now() });
  persist(s);
}

export function setReport(s, markdown) {
  s.status = 'reported';
  s.report = { markdown, generatedAt: Date.now() };
  s.postReportTurns = 0;
  persist(s);
}

// 标记对话整理 HTML 已生成（文件由调用方写入 conversationsDir）
export function setConversation(s, filePath) {
  s.conversationFile = filePath;
  s.conversationReady = true;
  persist(s);
}

// 隐私清理：报告生成后保留 reportTtlHours，超时删对话+报告；长期未报告(abandon)的会话按 abandonTtlDays 删
export function cleanup() {
  const now = Date.now();
  const ttl = config.reportTtlHours * 3600 * 1000;
  const abandonTtl = config.abandonTtlDays * 24 * 3600 * 1000;
  for (const [id, s] of sessions) {
    let expired = false;
    if (s.status === 'reported' && s.report) {
      expired = now - s.report.generatedAt > ttl;
    } else {
      expired = now - s.createdAt > abandonTtl;
    }
    if (expired) {
      sessions.delete(id);
      try {
        fs.unlinkSync(path.join(config.sessionsDir, `${id}.json`));
      } catch {
        /* ignore */
      }
      if (s.conversationFile) {
        try {
          fs.unlinkSync(s.conversationFile);
        } catch {
          /* ignore */
        }
      }
    }
  }
}

loadAll();
setInterval(cleanup, 60 * 60 * 1000);
