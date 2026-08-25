// 构建样例弹窗所需的静态片段：
// 1) shanda-dialogue.html —— 从对话记录 HTML 提取前 14 个气泡（7 轮用户发言 + 7 条 AI 回复，排除开场白），重排为 H5 气泡样式
// 2) shanda-report.html   —— 将脱敏版报告 Markdown 用 marked 转为 HTML，套 .sample-report 作用域（样式在 style.css）
import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';

const ROOT = '/Users/whl/WorkBuddy/hemo-career-compass-program';
const convoPath = path.join(ROOT, 'server/data/conversations/131****3599_20260823_2356.html');
const reportMdPath = path.join(ROOT, 'server/skill/reports/山大班长_脱敏版.md');
const outDir = path.join(ROOT, 'web/samples');

// ---------- 1. 提取对话气泡 ----------
const convo = fs.readFileSync(convoPath, 'utf8');
// 每个消息块：<div class="msg ai|user|ai report"> ... <div class="bubble">INNER</div></div>
const msgRe = /<div class="msg (ai|user|ai report)">[\s\S]*?<div class="bubble">([\s\S]*?)<\/div>\s*<\/div>/g;
const all = [];
let m;
while ((m = msgRe.exec(convo)) !== null) {
  const roleRaw = m[1];
  const role = roleRaw === 'user' ? 'me' : 'ai';
  all.push({ role, html: m[2].trim() });
}
console.log('提取到消息总数:', all.length);

// 排除开场白（首条 ai），取 7 轮用户发言 + 对应 7 条 AI 回复 = 14 气泡
const body = all.slice(1);
const sel = [];
let users = 0;
for (let i = 0; i < body.length; i++) {
  const msg = body[i];
  sel.push(msg);
  if (msg.role === 'me') {
    users += 1;
    if (users === 7) {
      const nxt = body[i + 1];
      if (nxt) sel.push(nxt); // 包含第 7 轮用户的 AI 回复
      break;
    }
  }
}
console.log('选中气泡数:', sel.length, '| 用户条数:', sel.filter((x) => x.role === 'me').length, '| AI条数:', sel.filter((x) => x.role === 'ai').length);

const dialogueHtml = sel
  .map((msg) => {
    const cls = msg.role === 'me' ? 'me' : 'ai';
    const av = msg.role === 'me' ? '你' : '罗';
    return `<div class="msg ${cls}"><div class="av">${av}</div><div class="bubble">${msg.html}</div></div>`;
  })
  .join('\n');
const dialogueDoc = `<div class="sample-dialogue">\n${dialogueHtml}\n</div>\n`;

// ---------- 2. 转换报告 Markdown ----------
let md = fs.readFileSync(reportMdPath, 'utf8');
md = md.replace(/&#x20;/g, ' '); // 清理原始 md 里的空格实体
marked.setOptions({ gfm: true, breaks: false });
const reportBody = marked.parse(md);
const reportDoc = `<div class="sample-report">\n${reportBody}\n</div>\n`;

// ---------- 写出 ----------
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'shanda-dialogue.html'), dialogueDoc, 'utf8');
fs.writeFileSync(path.join(outDir, 'shanda-report.html'), reportDoc, 'utf8');
console.log('已写出:', path.join(outDir, 'shanda-dialogue.html'), path.join(outDir, 'shanda-report.html'));
