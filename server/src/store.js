import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const sessions = new Map();

function ensureDirs() {
  fs.mkdirSync(config.sessionsDir, { recursive: true });
  fs.mkdirSync(config.reportsDir, { recursive: true });
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

export function createSession(referencer = 'general') {
  const id = crypto.randomUUID();
  const s = {
    id,
    createdAt: Date.now(),
    status: 'collecting', // collecting | reported
    referencer,
    messages: [],
    report: null,
    postReportTurns: 0,
  };
  sessions.set(id, s);
  persist(s);
  return s;
}

export function getSession(id) {
  return sessions.get(id);
}

export function persist(s) {
  fs.writeFileSync(path.join(config.sessionsDir, `${s.id}.json`), JSON.stringify(s));
}

export function addMessage(s, role, content) {
  s.messages.push({ role, content, ts: Date.now() });
  persist(s);
}

export function setReport(s, markdown, html) {
  s.status = 'reported';
  s.report = { markdown, html, generatedAt: Date.now() };
  s.postReportTurns = 0;
  persist(s);
  fs.writeFileSync(path.join(config.reportsDir, `${s.id}.html`), html);
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
      try {
        fs.unlinkSync(path.join(config.reportsDir, `${id}.html`));
      } catch {
        /* ignore */
      }
    }
  }
}

loadAll();
setInterval(cleanup, 60 * 60 * 1000);
