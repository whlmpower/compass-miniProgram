function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(s) {
  s = escapeHtml(s);
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  return s;
}

// 轻量 Markdown -> HTML（覆盖报告用到的语法：标题/段落/列表/引用/分割线/代码块/加粗）
export function renderReportHtml(markdown, title = '职业自我认知报告') {
  const lines = markdown.split('\n');
  let html = '';
  let inCode = false;
  let codeLang = '';
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
    const line = raw;
    if (line.startsWith('```')) {
      if (!inCode) {
        inCode = true;
        codeLang = line.slice(3).trim();
        codeBuf = [];
      } else {
        inCode = false;
        const cls = codeLang === 'mermaid' ? 'mermaid' : 'code';
        html += `<pre class="${cls}"><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    const t = line.trim();
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

  return page(html, title);
}

function page(body, title) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<style>
  :root{
    --ink:#1f2328; --muted:#66707a; --line:#e6e8eb; --brand:#3b6cff; --brand-ink:#2347b8;
    --bg:#f5f7fb; --card:#ffffff;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
    line-height:1.75;font-size:16px;}
  .toolbar{position:sticky;top:0;z-index:5;display:flex;gap:10px;justify-content:center;
    padding:12px;background:rgba(255,255,255,.92);backdrop-filter:blur(6px);border-bottom:1px solid var(--line);}
  .toolbar button{border:0;background:var(--brand);color:#fff;padding:10px 18px;border-radius:10px;font-size:15px;cursor:pointer;}
  .toolbar a{color:var(--brand-ink);text-decoration:none;align-self:center;font-size:14px;}
  main.report{max-width:780px;margin:0 auto;padding:28px 20px 80px;background:var(--card);min-height:100vh;}
  h1{font-size:26px;margin:8px 0 18px;letter-spacing:.5px;}
  h2{font-size:20px;margin:30px 0 12px;padding-left:10px;border-left:4px solid var(--brand);}
  h3{font-size:17px;margin:22px 0 8px;color:var(--brand-ink);}
  p{margin:10px 0;}
  ul,ol{margin:10px 0;padding-left:22px;}
  li{margin:6px 0;}
  blockquote{margin:16px 0;padding:12px 16px;background:#f0f4ff;border-left:4px solid var(--brand);
    border-radius:8px;color:var(--brand-ink);}
  hr{border:0;border-top:1px dashed var(--line);margin:26px 0;}
  table{border-collapse:collapse;width:100%;margin:14px 0;font-size:14px;}
  th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top;}
  th{background:#f0f4ff;color:var(--brand-ink);}
  pre.code{background:#0f172a;color:#e2e8f0;padding:14px;border-radius:10px;overflow:auto;font-size:13px;}
  pre.mermaid{background:#f8fafc;border:1px dashed var(--line);padding:12px;border-radius:10px;
    color:var(--muted);font-size:13px;white-space:pre-wrap;}
  strong{color:var(--ink);}
  @media print{
    body{background:#fff;}
    .toolbar{display:none;}
    main.report{max-width:none;padding:0;}
    pre.mermaid{white-space:pre-wrap;}
  }
</style>
</head>
<body>
  <div class="toolbar no-print">
    <button onclick="window.print()">打印 / 保存为 PDF</button>
    <a href="javascript:history.back()">返回</a>
  </div>
  <main class="report">${body}</main>
</body>
</html>`;
}
