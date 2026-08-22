// ===== 职业罗盘 H5 前端 · 应用逻辑 =====
import { api } from './api.js';

const $ = (id) => document.getElementById(id);
const CFG = { maxInputChars: 5000, maxPostReportRounds: 10, mock: false };
const state = {
  sessionId: null,
  meta: null,
  messages: [],
  reportReady: false,
};
let captchaId = '';

// ---------- 视图切换 + 入场动画 ----------
const views = ['home', 'login', 'admin', 'chat', 'report'];
function go(v) {
  views.forEach((id) => {
    const el = $('view-' + id);
    el.classList.toggle('active', id === v);
    if (id === v) {
      el.classList.remove('show');
      void el.offsetWidth;
      el.classList.add('show');
    }
  });
  if (v === 'login') {
    $('loginErr').textContent = '';
    loadCaptcha();
  }
  if (v === 'admin' && api.token && api.role === 'admin') loadAdmin();
  if (v === 'chat') {
    renderChat();
    renderChatPhase();
  }
  window.scrollTo(0, 0);
}

document.querySelectorAll('[data-go]').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    go(a.dataset.go);
  });
});

// ---------- 配置 ----------
async function loadConfig() {
  try {
    const { data } = await api.get('/api/config');
    if (data) Object.assign(CFG, { maxInputChars: data.maxInputChars, maxPostReportRounds: data.maxPostReportRounds, mock: data.mock });
  } catch {
    /* 默认兜底 */
  }
}

// ---------- 导航态 ----------
function updateNav() {
  const loggedIn = !!api.token;
  $('navLogin').style.display = loggedIn ? 'none' : '';
  $('navAdmin').style.display = loggedIn && api.role === 'admin' ? '' : 'none';
}

// ---------- 会话 ----------
async function getMeta() {
  if (!state.sessionId) return null;
  const { res, data } = await api.get(`/api/session/${state.sessionId}`);
  if (res.ok) return data;
  return null;
}

async function ensureSession() {
  if (state.sessionId) {
    const meta = await getMeta();
    if (meta) {
      state.meta = meta;
      return true;
    }
    state.sessionId = null;
    state.messages = [];
  }
  const { res, data } = await api.post('/api/session', {});
  if (!res.ok) {
    if (res.status === 401) {
      api.clear();
      updateNav();
      go('login');
    }
    return false;
  }
  state.sessionId = data.sessionId;
  state.messages = [{ role: 'assistant', content: data.greeting }];
  state.meta = await getMeta();
  return true;
}

async function startDiagnosis() {
  if (api.token && api.role === 'user') {
    if (await ensureSession()) go('chat');
  } else {
    go('login');
  }
}
$('startBtn').addEventListener('click', startDiagnosis);
$('sampleStartBtn').addEventListener('click', () => {
  closeMask('sampleMask');
  startDiagnosis();
});

// ---------- 登录 ----------
async function loadCaptcha() {
  const { res, data } = await api.post('/api/auth/captcha', {});
  if (res.ok) {
    captchaId = data.captchaId;
    $('captchaSvg').innerHTML = data.svg;
  }
}
$('captchaBox').addEventListener('click', loadCaptcha);
$('agreeChk').addEventListener('change', () => {
  $('loginBtn').disabled = !$('agreeChk').checked;
});
$('agreePrivacy').addEventListener('click', (e) => {
  e.preventDefault();
  openMask('privacyMask');
});

$('loginBtn').addEventListener('click', async () => {
  if (!$('agreeChk').checked) {
    $('loginErr').textContent = '请先阅读并同意隐私协议';
    return;
  }
  const phone = $('phone').value.trim();
  const captchaInput = $('captchaInput').value.trim();
  const password = $('password').value;
  $('loginErr').textContent = '';
  const { res, data } = await api.post('/api/auth/login', { phone, captchaId, captchaInput, password });
  if (res.ok) {
    api.setSession(data.token, data.role);
    onLoggedIn(data.role);
  } else {
    $('loginErr').textContent = data?.error || '登录失败';
    if (data?.error === '图形验证码不正确') {
      $('captchaInput').value = '';
      loadCaptcha();
    } else {
      $('password').value = '';
    }
  }
});

function onLoggedIn(role) {
  updateNav();
  if (role === 'admin') {
    go('admin');
  } else {
    ensureSession().then((ok) => {
      if (ok) go('chat');
    });
  }
}

// ---------- 诊断对话 ----------
function renderChat() {
  const box = $('msgs');
  box.innerHTML = '';
  state.messages.forEach((m) => appendMsgEl(m.role, m.content));
  window.scrollTo(0, document.body.scrollHeight);
}
function appendMsgEl(role, text) {
  const m = document.createElement('div');
  m.className = 'msg ' + (role === 'me' ? 'me' : 'ai');
  m.innerHTML = `<div class="av">${role === 'me' ? '你' : '罗'}</div><div class="bubble"></div>`;
  m.querySelector('.bubble').textContent = text;
  $('msgs').appendChild(m);
  window.scrollTo(0, document.body.scrollHeight);
}

function renderChatPhase() {
  const tag = $('phaseTagWrap');
  const label = $('phaseLabel');
  const row = $('composerRow');
  const locked = $('lockedWrap');
  const genBtn = $('genReportBtn');
  const repBtn = $('reportBtn');
  const reported = state.meta && state.meta.status === 'reported';
  if (!reported) {
    label.textContent = '诊断进行中';
    tag.innerHTML = '<span class="phase-tag">诊断阶段 · 不限轮次</span>';
    genBtn.style.display = 'inline-flex';
    repBtn.style.display = 'none';
    row.style.display = 'flex';
    locked.style.display = 'none';
  } else {
    label.textContent = '追问阶段';
    const left = state.meta.postReportTurnsLeft;
    tag.innerHTML = `<span class="phase-tag">追问剩余 ${left} 轮</span>`;
    genBtn.style.display = 'none';
    repBtn.style.display = 'inline-flex';
    if (left <= 0) {
      row.style.display = 'none';
      locked.style.display = 'block';
    } else {
      row.style.display = 'flex';
      locked.style.display = 'none';
    }
  }
}

const ta = $('ta');
const counter = $('counter');
ta.addEventListener('input', () => {
  const n = ta.value.length;
  counter.textContent = `${n} / ${CFG.maxInputChars}`;
  counter.classList.toggle('warn', n > CFG.maxInputChars);
  if (n > CFG.maxInputChars) ta.value = ta.value.slice(0, CFG.maxInputChars);
});

$('sendBtn').addEventListener('click', sendMessage);
async function sendMessage() {
  const text = ta.value.trim();
  if (!text) return;
  if (text.length > CFG.maxInputChars) {
    alert(`单轮最多 ${CFG.maxInputChars} 字`);
    return;
  }
  state.messages.push({ role: 'user', content: text });
  appendMsgEl('user', text);
  ta.value = '';
  counter.textContent = `0 / ${CFG.maxInputChars}`;

  const ti = document.createElement('div');
  ti.className = 'msg ai';
  ti.innerHTML = '<div class="av">罗</div><div class="bubble typing">思考中…</div>';
  $('msgs').appendChild(ti);

  const { res, data } = await api.post(`/api/session/${state.sessionId}/message`, { content: text });
  ti.remove();
  if (!res.ok) {
    if (res.status === 401) {
      api.clear();
      updateNav();
      go('login');
      return;
    }
    alert(data?.error || '发送失败');
    return;
  }
  state.messages.push({ role: 'assistant', content: data.reply });
  appendMsgEl('ai', data.reply);
  if (state.meta && state.meta.status === 'reported') {
    state.meta.postReportTurnsLeft = data.postReportTurnsLeft;
    renderChatPhase();
  }
}

$('genReportBtn').addEventListener('click', generateReport);
async function generateReport() {
  const btn = $('genReportBtn');
  btn.disabled = true;
  const { res, data } = await api.post(`/api/session/${state.sessionId}/report`, {});
  if (!res.ok) {
    alert(data?.error || '报告生成失败');
    btn.disabled = false;
    return;
  }
  state.reportReady = true;
  state.meta = await getMeta();
  await loadReport();
  go('report');
}

$('reportBtn').addEventListener('click', async () => {
  await loadReport();
  go('report');
});

// 报告预览：取回鉴权后的 HTML，写入 iframe（sandbox）
async function loadReport() {
  const { res } = await api.get(`/api/session/${state.sessionId}/report/download`);
  if (!res.ok) return;
  const html = await res.text();
  const frame = $('reportFrame');
  const doc = frame.contentDocument || frame.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();
}

// 新窗口打开 / 下载（PDF）：用鉴权后的 Blob 触发下载
$('openNew').addEventListener('click', async () => {
  const { res } = await api.get(`/api/session/${state.sessionId}/report/download`);
  if (!res.ok) {
    alert('报告获取失败');
    return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `职业诊断报告_${state.sessionId}.html`;
  a.click();
  URL.revokeObjectURL(url);
});

// ---------- Admin ----------
function maskPhone(p) {
  if (!p || p.length < 11) return p;
  return p.slice(0, 3) + '****' + p.slice(7);
}
function statusText(s) {
  return { unused: '未使用', used: '已使用', expired: '已过期', revoked: '已作废' }[s] || s;
}
function fmt(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function loadAdmin() {
  const me = await api.get('/api/me');
  if (me.res.ok) $('adminPhone').textContent = maskPhone(me.data.phone);
  const { res, data } = await api.get('/api/admin/users');
  if (res.ok) {
    renderUsers(data.users || []);
  } else if (res.status === 401) {
    api.clear();
    updateNav();
    go('login');
  } else if (res.status === 403) {
    alert('无管理员权限');
    go('home');
  }
}

function renderUsers(users) {
  const tb = $('userRows');
  tb.innerHTML = '';
  if (!users.length) {
    tb.innerHTML = '<tr><td colspan="5" style="color:var(--ink-3)">暂无用户</td></tr>';
    return;
  }
  for (const u of users) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${u.phoneMasked}</td><td><span class="st ${u.status}">${statusText(u.status)}</span></td><td>${fmt(u.createdAt)}</td><td>${fmt(u.expiresAt)}</td><td><div class="admin-row-actions"></div></td>`;
    const actions = tr.querySelector('.admin-row-actions');
    const reset = document.createElement('button');
    reset.className = 'mini-btn';
    reset.textContent = '重生成';
    reset.onclick = () => adminReset(u.phone);
    const revoke = document.createElement('button');
    revoke.className = 'mini-btn';
    revoke.textContent = u.status === 'revoked' ? '已作废' : '作废';
    revoke.onclick = () => adminRevoke(u.phone);
    actions.append(reset, revoke);
    tb.appendChild(tr);
  }
}

$('genBtn').addEventListener('click', async () => {
  const phone = $('genPhone').value.trim();
  if (!/^1\d{10}$/.test(phone)) {
    alert('请输入有效的 11 位手机号');
    return;
  }
  const { res, data } = await api.post('/api/admin/users', { phone });
  if (res.ok) {
    $('pwCode').textContent = data.password;
    $('pwOut').classList.add('show');
    loadAdmin();
  } else {
    alert(data?.error || '生成失败');
  }
});

$('copyPw').addEventListener('click', () => {
  const t = $('pwCode').textContent;
  navigator.clipboard?.writeText(t);
  $('copyPw').textContent = '已复制';
  setTimeout(() => ($('copyPw').textContent = '复制'), 1500);
});

async function adminReset(phone) {
  const { res, data } = await api.post(`/api/admin/users/${phone}/reset`, {});
  if (res.ok) {
    $('pwCode').textContent = data.password;
    $('pwOut').classList.add('show');
    loadAdmin();
  } else {
    alert(data?.error || '操作失败');
  }
}
async function adminRevoke(phone) {
  if (!confirm('确认作废该账号？作废后该密码将立即失效。')) return;
  const { res, data } = await api.post(`/api/admin/users/${phone}/revoke`, {});
  if (res.ok) loadAdmin();
  else alert(data?.error || '操作失败');
}

$('changePwBtn').addEventListener('click', async () => {
  const oldPwd = $('oldPwd').value;
  const newPwd = $('newPwd').value;
  if (!oldPwd || !newPwd) {
    $('pwErr').style.color = '#9a3b2e';
    $('pwErr').textContent = '请输入旧密码与新密码';
    return;
  }
  const { res, data } = await api.put('/api/admin/password', { oldPwd, newPwd });
  if (res.ok) {
    $('pwErr').style.color = '#2B3A5E';
    $('pwErr').textContent = '密码已更新';
    $('oldPwd').value = '';
    $('newPwd').value = '';
  } else {
    $('pwErr').style.color = '#9a3b2e';
    $('pwErr').textContent = data?.error || '更新失败';
  }
});

$('logoutBtn').addEventListener('click', (e) => {
  e.preventDefault();
  api.clear();
  updateNav();
  go('home');
});

// ---------- 弹层 ----------
function openMask(id) {
  $(id).classList.add('open');
}
function closeMask(id) {
  $(id).classList.remove('open');
}
$('openPrivacy').addEventListener('click', () => openMask('privacyMask'));
$('closePrivacy').addEventListener('click', () => closeMask('privacyMask'));
$('openSample').addEventListener('click', async () => {
  await fillSample();
  openMask('sampleMask');
});
$('closeSample').addEventListener('click', () => closeMask('sampleMask'));
['privacyMask', 'sampleMask'].forEach((id) =>
  $(id).addEventListener('click', (e) => {
    if (e.target.id === id) closeMask(id);
  })
);

// ---------- 样例数据（固化到 web/samples/） ----------
async function fillSample() {
  try {
    const r = await fetch('/samples/shanda.json');
    const s = await r.json();
    $('sampleCardTitle').textContent = s.title;
    $('sampleCardMeta').textContent = s.meta;
    const cp = $('sampleCardPoints');
    cp.innerHTML = '';
    (s.cardPoints || []).forEach((p) => {
      const li = document.createElement('li');
      li.textContent = p;
      cp.appendChild(li);
    });
    $('sampleModalTitle').textContent = s.title;
    $('sampleModalMeta').textContent = s.meta;
    const dlg = $('sampleModalDialogue');
    dlg.innerHTML = '';
    (s.dialogue || []).forEach((m) => {
      const p = document.createElement('p');
      p.textContent = (m.role === 'ai' ? '罗：' : '用户：') + m.text;
      dlg.appendChild(p);
    });
    const con = $('sampleModalConclusion');
    con.innerHTML = '';
    (s.conclusion || []).forEach((c) => {
      const p = document.createElement('p');
      p.textContent = c;
      con.appendChild(p);
    });
  } catch {
    /* 忽略 */
  }
}

// ---------- 初始化 ----------
(async () => {
  await loadConfig();
  await fillSample();
  if (api.token) {
    const { res, data } = await api.get('/api/me');
    if (res.ok) {
      api.role = data.role;
    } else {
      api.clear();
    }
  }
  updateNav();
  go('home');
})();
