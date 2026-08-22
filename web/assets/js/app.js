// ===== 职业罗盘 H5 前端 =====
const CFG = { adDurationSec: 10, maxInputChars: 5000, postReportTurns: 10, mock: true };
const state = { sessionId: null, meta: null, messages: [] };
const $ = (id) => document.getElementById(id);
const VIEWS = ['home', 'privacy', 'sample', 'ad', 'diagnose'];

function showView(name) {
  VIEWS.forEach((v) => {
    const el = $('view-' + v);
    if (el) el.classList.toggle('hidden', v !== name);
  });
}

// 全局导航（data-go 属性）
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) showView(go.getAttribute('data-go'));
});

// ---------- 配置 ----------
async function loadConfig() {
  try {
    const r = await fetch('/api/config');
    Object.assign(CFG, await r.json());
  } catch (_) { /* 用默认值兜底 */ }
}

// ---------- 首页 ----------
$('agree').addEventListener('change', (e) => { $('startBtn').disabled = !e.target.checked; });
$('startBtn').addEventListener('click', startDiagnosis);

async function startDiagnosis() {
  $('startBtn').disabled = true;
  if (!state.sessionId) {
    const r = await fetch('/api/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const d = await r.json();
    state.sessionId = d.sessionId;
    state.messages = [{ role: 'assistant', content: d.greeting }];
    localStorage.setItem('hcc_session', state.sessionId);
  }
  // 入口广告闸门
  playAd('entry', async () => {
    await postAd('entry');
    state.meta = await getMeta();
    enterDiagnose();
  });
}

// ---------- 会话元信息 ----------
async function getMeta() {
  const r = await fetch(`/api/session/${state.sessionId}`);
  return r.json();
}
async function postAd(type) {
  await fetch(`/api/session/${state.sessionId}/ad`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type }),
  });
}

// ---------- 广告倒计时 ----------
function playAd(type, onDone) {
  showView('ad');
  let left = CFG.adDurationSec;
  $('adCount').textContent = left;
  $('adSkip').disabled = true;
  $('adSkip').classList.remove('on');
  $('adSkip').textContent = '请稍候…';
  $('adText').textContent = type === 'entry' ? '广告播放中，观看后可进入诊断' : '广告播放中，观看后可下载报告';
  const timer = setInterval(() => {
    left -= 1;
    $('adCount').textContent = Math.max(0, left);
    if (left <= 0) {
      clearInterval(timer);
      $('adSkip').disabled = false;
      $('adSkip').classList.add('on');
      $('adSkip').textContent = '继续';
    }
  }, 1000);
  $('adSkip').onclick = () => {
    if (left > 0) return;
    clearInterval(timer);
    onDone();
  };
}

// ---------- 诊断页 ----------
function enterDiagnose() {
  showView('diagnose');
  renderChat();
  renderReportZone();
  syncComposer();
}

function renderChat() {
  const box = $('chat');
  box.innerHTML = '';
  state.messages.forEach((m) => {
    const d = document.createElement('div');
    d.className = 'msg ' + (m.role === 'user' ? 'me' : 'ai');
    d.textContent = m.content;
    box.appendChild(d);
  });
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
}

function syncComposer() {
  const reported = state.meta && state.meta.status === 'reported';
  const left = state.meta ? state.meta.postReportTurnsLeft : CFG.postReportTurns;
  const locked = reported && left <= 0;
  $('composer').classList.toggle('hidden', locked);
  $('turnsInfo').textContent = reported ? `追问剩 ${left} 轮` : '';
}

function renderReportZone() {
  const z = $('reportZone');
  z.innerHTML = '';
  const reported = state.meta && state.meta.status === 'reported';
  if (!reported) {
    const b = document.createElement('button');
    b.className = 'primary';
    b.textContent = '生成我的报告';
    b.onclick = generateReport;
    z.appendChild(b);
    const tip = document.createElement('p');
    tip.className = 'hint';
    tip.textContent = '聊得差不多了，点此生成专属诊断报告。';
    z.appendChild(tip);
  } else {
    const dl = document.createElement('button');
    dl.className = 'primary';
    dl.textContent = '查看 / 下载报告（PDF）';
    dl.onclick = downloadReport;
    z.appendChild(dl);
    const left = state.meta.postReportTurnsLeft;
    const banner = document.createElement('div');
    if (left > 0) {
      banner.className = 'banner';
      banner.textContent = `报告已生成。你还可以就报告追问 ${left} 轮，之后对话将关闭。`;
    } else {
      banner.className = 'banner locked';
      banner.textContent = '追问轮次已用完，对话已结束。可随时查看 / 下载报告。';
    }
    z.appendChild(banner);
  }
}

async function sendMessage() {
  const input = $('input');
  const text = input.value.trim();
  if (!text) return;
  if (text.length > CFG.maxInputChars) { alert(`单轮最多 ${CFG.maxInputChars} 字`); return; }

  state.messages.push({ role: 'user', content: text });
  renderChat();
  input.value = '';
  $('count').textContent = `0 / ${CFG.maxInputChars}`;

  const ti = document.createElement('div');
  ti.className = 'msg ai typing';
  ti.textContent = '思考中…';
  $('chat').appendChild(ti);

  const r = await fetch(`/api/session/${state.sessionId}/message`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text }),
  });
  ti.remove();
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: '请求失败' }));
    alert(err.error || '发送失败');
    return;
  }
  const d = await r.json();
  state.messages.push({ role: 'assistant', content: d.reply });
  renderChat();
  if (state.meta && state.meta.status === 'reported') {
    state.meta.postReportTurnsLeft = d.postReportTurnsLeft;
    syncComposer();
    renderReportZone();
  }
}

$('sendBtn').addEventListener('click', sendMessage);
$('input').addEventListener('input', (e) => {
  $('count').textContent = `${e.target.value.length} / ${CFG.maxInputChars}`;
});

async function generateReport() {
  const b = document.querySelector('#reportZone .primary');
  if (b) b.disabled = true;
  const r = await fetch(`/api/session/${state.sessionId}/report`, { method: 'POST' });
  if (!r.ok) { alert('报告生成失败'); if (b) b.disabled = false; return; }
  state.meta = await getMeta();
  renderReportZone();
  syncComposer();
}

async function downloadReport() {
  if (state.meta && state.meta.adDownloadUnlocked) {
    window.open(`/api/session/${state.sessionId}/report/download`, '_blank');
    return;
  }
  playAd('download', async () => {
    await postAd('download');
    state.meta = await getMeta();
    window.open(`/api/session/${state.sessionId}/report/download`, '_blank');
  });
}

// ---------- 刷新续聊 ----------
async function restoreOrHome() {
  const sid = localStorage.getItem('hcc_session');
  if (!sid) { state.sessionId = null; state.meta = null; state.messages = []; showView('home'); return; }
  state.sessionId = sid;
  try {
    const r = await fetch(`/api/session/${sid}`);
    if (!r.ok) { localStorage.removeItem('hcc_session'); showView('home'); return; }
    state.meta = await r.json();
    state.messages = state.meta.messages || [];
    if (state.meta.adEntryUnlocked) {
      enterDiagnose();
    } else {
      // 之前已同意过协议，直接放行到首页，点开始即看广告进入
      showView('home');
      $('agree').checked = true;
      $('startBtn').disabled = false;
    }
  } catch (_) { showView('home'); }
}

// ---------- 初始化 ----------
(async () => {
  await loadConfig();
  restoreOrHome();
})();
