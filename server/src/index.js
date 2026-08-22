import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { config, isMock } from './config.js';
import { buildSystemPrompt, buildReportInstruction, listReferencers } from './skillLoader.js';
import { chat, mockReport } from './llm.js';
import { renderReportHtml } from './report.js';
import {
  createSession,
  getSession,
  addMessage,
  setReport,
  persist,
} from './store.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// 静态资源：H5 前端 + 已生成报告的下载/预览
app.use(express.static(path.join(config.rootDir, '..', 'web')));
app.use('/reports', express.static(config.reportsDir));

const sysPrompt = buildSystemPrompt();

function publicConfig() {
  return {
    adDurationSec: config.adDurationSec,
    maxInputChars: config.maxInputChars,
    postReportTurns: config.postReportTurns,
    mock: isMock(),
    referencers: listReferencers(),
  };
}

app.get('/api/config', (req, res) => {
  res.json(publicConfig());
});

// 创建会话（可选选择参照系），并立即生成 AI 开场白
app.post('/api/session', async (req, res) => {
  try {
    const referencer = req.body?.referencer || 'general';
    const s = createSession(referencer);
    const greeting = await chat(sysPrompt, []);
    addMessage(s, 'assistant', greeting);
    res.json({ sessionId: s.id, greeting, config: publicConfig() });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// 恢复会话元信息（供前端刷新/重入时对齐状态）
app.get('/api/session/:id', (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: '会话不存在' });
  res.json({
    status: s.status,
    adEntryUnlocked: s.adEntryUnlocked,
    adDownloadUnlocked: s.adDownloadUnlocked,
    postReportTurns: s.postReportTurns,
    postReportTurnsLeft: Math.max(0, config.postReportTurns - s.postReportTurns),
    referencer: s.referencer,
    reportReady: !!s.report,
    messageCount: s.messages.length,
    messages: s.messages,
  });
});

// 发送一条对话消息
app.post('/api/session/:id/message', async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: '会话不存在' });

  if (!s.adEntryUnlocked) {
    return res.status(403).json({ error: '请先看完广告解锁诊断' });
  }
  if (s.status === 'reported' && s.postReportTurns >= config.postReportTurns) {
    return res.status(403).json({ error: '报告后的追问轮次已用完，对话已结束' });
  }

  const content = (req.body?.content || '').trim();
  if (!content) return res.status(400).json({ error: '请输入内容' });
  if (content.length > config.maxInputChars) {
    return res.status(400).json({ error: `单轮输入不能超过 ${config.maxInputChars} 字` });
  }

  try {
    addMessage(s, 'user', content);
    const extraSystem = s.status === 'reported' && s.report
      ? `以下是已生成的报告全文，用户可能就报告内容追问：\n${s.report.markdown}`
      : '';
    const reply = await chat(sysPrompt, s.messages, { extraSystem });
    addMessage(s, 'assistant', reply);
    if (s.status === 'reported') {
      s.postReportTurns += 1;
      persist(s);
    }
    res.json({
      reply,
      postReportTurnsLeft: Math.max(0, config.postReportTurns - s.postReportTurns),
    });
  } catch (e) {
    res.status(502).json({ error: `模型调用失败：${e.message || e}` });
  }
});

// 生成报告（仅诊断阶段可触发一次）
app.post('/api/session/:id/report', async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: '会话不存在' });
  if (s.status !== 'collecting') {
    return res.status(400).json({ error: '报告已生成，不能重复生成' });
  }

  try {
    let markdown;
    if (isMock()) {
      markdown = mockReport();
    } else {
      const instruction = buildReportInstruction(s.referencer);
      markdown = await chat(sysPrompt, s.messages, { extraSystem: instruction, temperature: 0.6 });
    }
    const html = renderReportHtml(markdown);
    setReport(s, markdown, html);
    res.json({ reportHtml: html, reportMarkdown: markdown });
  } catch (e) {
    res.status(502).json({ error: `报告生成失败：${e.message || e}` });
  }
});

// 广告看完后解锁（entry=进入诊断，download=下载报告）
app.post('/api/session/:id/ad', (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: '会话不存在' });
  const type = req.body?.type;
  if (type === 'entry') s.adEntryUnlocked = true;
  else if (type === 'download') s.adDownloadUnlocked = true;
  else return res.status(400).json({ error: '未知广告类型' });
  persist(s);
  res.json({ ok: true });
});

// 下载报告（需先看完下载广告）
app.get('/api/session/:id/report/download', (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: '会话不存在' });
  if (!s.adDownloadUnlocked) {
    return res.status(403).json({ error: '请先看完广告解锁下载' });
  }
  if (!s.report) return res.status(404).json({ error: '报告尚未生成' });
  res.sendFile(path.join(config.reportsDir, `${s.id}.html`));
});

app.listen(config.port, () => {
  console.log(`[hemo-career-compass] server on http://localhost:${config.port}  (mock=${isMock()})`);
});
