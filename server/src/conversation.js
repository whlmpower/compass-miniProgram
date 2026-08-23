// 对话整理 HTML 渲染：将「到报告生成为止」的完整对话流渲染为可下载的 HTML 文件。
// 含标题区（脱敏手机号 + 生成时间 + 参照系），报告那条做视觉高亮。

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 轻量 Markdown 行内 -> HTML（加粗 + 段落 + 列表 + 引用 + 分割线 + 代码块）
function inline(s) {
  s = escapeHtml(s);
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  return s;
}

function maskPhone(p) {
  if (!p || p.length < 7) return p || '用户';
  return p.slice(0, 3) + '****' + p.slice(-4);
}

// 简单把一段 markdown 文本切成块（与 report.js 类似，但不会再套外层 page）
function renderBlocks(markdown) {
  const lines = markdown.split('\n');
  let html = '';
  let inCode = false;
  let codeBuf = [];
  let listOpen = false;
  let listTag = '';

  const closeList = () => {
    if (listOpen) {
      html += `</${listTag}>`;
      listOpen = false;
    }
  };

  for (const raw of lines) {
    if (raw.startsWith('```')) {
      if (!inCode) {
        inCode = true;
        codeBuf = [];
      } else {
        inCode = false;
        html += `<pre class="code"><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(raw);
      continue;
    }
    const t = raw.trim();
    if (!t) {
      closeList();
      continue;
    }
    if (t.startsWith('### ')) {
      closeList();
      html += `<h3>${inline(t.slice(4))}</h3>`;
    } else if (t.startsWith('## ')) {
      closeList();
      html += `<h2>${inline(t.slice(3))}</h2>`;
    } else if (t.startsWith('# ')) {
      closeList();
      html += `<h1>${inline(t.slice(2))}</h1>`;
    } else if (t.startsWith('> ')) {
      closeList();
      html += `<blockquote>${inline(t.slice(2))}</blockquote>`;
    } else if (/^- /.test(t)) {
      if (!listOpen || listTag !== 'ul') {
        closeList();
        html += '<ul>';
        listOpen = true;
        listTag = 'ul';
      }
      html += `<li>${inline(t.slice(2))}</li>`;
    } else if (/^\d+\.\s/.test(t)) {
      if (!listOpen || listTag !== 'ol') {
        closeList();
        html += '<ol>';
        listOpen = true;
        listTag = 'ol';
      }
      html += `<li>${inline(t.replace(/^\d+\.\s/, ''))}</li>`;
    } else if (t === '---') {
      closeList();
      html += '<hr/>';
    } else {
      closeList();
      html += `<p>${inline(t)}</p>`;
    }
  }
  closeList();
  return html;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// 生成文件名：脱敏手机号_YYYYMMDD_HHmm.html
export function buildConversationFileName(phone, date = new Date()) {
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `${maskPhone(phone)}_${stamp}.html`;
}

export function renderConversationHtml({ phone, referencer, messages, generatedAt = Date.now() }) {
  const dt = new Date(generatedAt);
  const timeStr = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
  const refLabel = referencer && referencer !== 'general' ? referencer : '综合参照系';

  const rows = messages
    .map((m) => {
      const isUser = m.role === 'user';
      const isReport = m.role === 'assistant' && m.isReport;
      const bubbleCls = isUser ? 'user' : isReport ? 'ai report' : 'ai';
      const avatar = isUser ? '你' : '罗';
      const body = isReport ? renderBlocks(m.content) : `<p>${inline(m.content)}</p>`;
      const tag = isReport ? '<div class="msg-tag">诊断报告</div>' : '';
      return `<div class="msg ${bubbleCls}">${tag}<div class="av">${avatar}</div><div class="bubble">${body}</div></div>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>职业诊断对话记录 - ${maskPhone(phone)}</title>
<style>
  :root{
    --ink:#1f2328; --muted:#66707a; --line:#e6e8eb; --brand:#3b6cff; --brand-ink:#2347b8;
    --bg:#f5f7fb; --card:#ffffff; --user-bg:#e8f0ff; --report-bg:#fff7e6; --report-line:#f0a500;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
    line-height:1.7;font-size:16px;}
  header.meta{max-width:820px;margin:0 auto;padding:24px 20px 12px;}
  header.meta h1{font-size:22px;margin:0 0 8px;letter-spacing:.5px;}
  header.meta .sub{color:var(--muted);font-size:14px;}
  header.meta .sub span{margin-right:16px;}
  main{max-width:820px;margin:0 auto;padding:8px 20px 80px;}
  .msg{display:flex;gap:10px;margin:18px 0;align-items:flex-start;}
  .av{flex:0 0 36px;height:36px;border-radius:50%;background:var(--brand);color:#fff;
    display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;}
  .msg.user{flex-direction:row-reverse;}
  .msg.user .av{background:#94a3b8;}
  .msg-tag{width:100%;font-size:12px;color:var(--report-line);font-weight:600;margin-bottom:4px;}
  .msg.report{flex-direction:column;align-items:stretch;}
  .msg.report .av{align-self:flex-start;}
  .bubble{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;max-width:88%;}
  .msg.user .bubble{background:var(--user-bg);border-color:#cfe0ff;}
  .msg.report .bubble{background:var(--report-bg);border:1px solid var(--report-line);max-width:100%;}
  .bubble h1{font-size:21px;margin:6px 0 14px;}
  .bubble h2{font-size:18px;margin:22px 0 10px;padding-left:10px;border-left:4px solid var(--brand);}
  .bubble h3{font-size:16px;margin:18px 0 6px;color:var(--brand-ink);}
  .bubble p{margin:8px 0;}
  .bubble ul,.bubble ol{margin:8px 0;padding-left:22px;}
  .bubble li{margin:5px 0;}
  .bubble blockquote{margin:12px 0;padding:10px 14px;background:#fff;border-left:4px solid var(--report-line);
    border-radius:8px;color:#8a5a00;}
  .bubble hr{border:0;border-top:1px dashed var(--line);margin:20px 0;}
  .bubble pre.code{background:#0f172a;color:#e2e8f0;padding:12px;border-radius:10px;overflow:auto;font-size:13px;}
  .footnote{text-align:center;color:var(--muted);font-size:12px;margin-top:30px;}
  @media print{
    body{background:#fff;}
    main{max-width:none;}
  }
</style>
</head>
<body>
  <header class="meta">
    <h1>职业诊断对话记录</h1>
    <div class="sub">
      <span>用户：${maskPhone(phone)}</span>
      <span>参照系：${escapeHtml(refLabel)}</span>
      <span>生成时间：${timeStr}</span>
    </div>
  </header>
  <main>
${rows}
    <div class="footnote">本记录由对话生成，仅用于自我认知参考，不构成职业决策建议。生成 24 小时后自动删除。</div>
  </main>
</body>
</html>`;
}
