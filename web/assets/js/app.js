// ===== 职业罗盘 H5 前端 · 应用逻辑 =====
import { api } from './api.js';

const $ = (id) => document.getElementById(id);
const CFG = { maxInputChars: 5000, maxPostReportRounds: 10, mock: false };

// ---------- Markdown 渲染（marked 解析 + DOMPurify 净化，防 XSS） ----------
function renderMarkdown(text) {
  try {
    const raw = window.marked ? window.marked.parse(text || '') : (text || '');
    if (window.DOMPurify) return window.DOMPurify.sanitize(raw);
    return raw;
  } catch {
    return text || '';
  }
}

// 给 Markdown 渲染后的 bubble 内的基础样式见 assets/css/style.css 的 .bubble 区块
const state = {
  sessionId: null,
  meta: null,
  messages: [],
  reportReady: false,
  reportHtml: '', // 报告正文的渲染结果（报告页优先展示，不依赖对话整理 HTML）
  conversationReady: false,
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
  if (v === 'admin' && api.authed && api.role === 'admin') loadAdmin();
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
  const loggedIn = api.authed;
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

// 当前用户最近一个有效会话（刷新后恢复历史用）
async function getMine() {
  const { res, data } = await api.get('/api/sessions/mine');
  if (res.ok && data.session) return data.session;
  return null;
}

// 把服务端返回的会话概要写入前端 state（含历史消息）
function applyMeta(meta) {
  state.meta = meta;
  state.reportReady = !!meta.reportReady;
  state.reportHtml = meta.reportHtml || ''; // 刷新恢复时带回报告正文，报告页可直接渲染
  state.conversationReady = !!meta.conversationReady;
  state.messages = (meta.messages || []).map((m) => ({ role: m.role, content: m.content }));
}

// autoCreate=false 时只恢复已有会话、不新建（用于登录/刷新自动续接）；
// autoCreate=true 时恢复最近一个，没有则新建（用于点击「开始诊断」）。
async function ensureSession({ autoCreate = true } = {}) {
  // 1) 内存中已有 sessionId 且仍有效 → 直接复用
  if (state.sessionId) {
    const meta = await getMeta();
    if (meta) {
      applyMeta(meta);
      return true;
    }
    state.sessionId = null;
    state.messages = [];
  }
  // 2) 恢复最近一个属于本用户的会话
  const mine = await getMine();
  if (mine) {
    state.sessionId = mine.id;
    const meta = await getMeta();
    if (meta) {
      applyMeta(meta);
      return true;
    }
    state.sessionId = null;
    state.messages = [];
  }
  // 3) 没有历史会话 → 按需新建
  if (!autoCreate) return false;
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
  state.reportReady = false;
  state.conversationReady = false;
  return true;
}

// 新建一次对话：保留旧会话于历史，开一个全新会话
async function startNewSession() {
  if (!confirm('开始一次新的诊断？当前对话会保留在历史中，刷新后可恢复。')) return;
  const { res, data } = await api.post('/api/session', {});
  if (!res.ok) {
    if (res.status === 401) {
      api.clear();
      updateNav();
      go('login');
      return;
    }
    alert(data?.error || '新建失败');
    return;
  }
  state.sessionId = data.sessionId;
  state.messages = [{ role: 'assistant', content: data.greeting }];
  state.meta = await getMeta();
  state.reportReady = false;
  state.conversationReady = false;
  go('chat');
  window.scrollTo(0, 0);
}

async function startDiagnosis() {
  if (api.authed && api.role === 'user') {
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

// 新建对话（保留旧会话于历史，开全新会话）
$('newChatBtn').addEventListener('click', startNewSession);

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
    // 仅恢复已有会话（不静默新建）；有历史则进对话页，否则回首页
    ensureSession({ autoCreate: false }).then((ok) => {
      if (ok) go('chat');
      else go('home');
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
  const isMe = role === 'user' || role === 'me';
  m.className = 'msg ' + (isMe ? 'me' : 'ai');
  m.innerHTML = `<div class="av">${isMe ? '你' : '罗'}</div><div class="bubble"></div>`;
  m.querySelector('.bubble').innerHTML = renderMarkdown(text);
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

  let res, data;
  try {
    ({ res, data } = await api.post(`/api/session/${state.sessionId}/message`, { content: text }));
  } catch (err) {
    // 超时 / 无法连接服务：移除“思考中”气泡，明确提示，避免无限转圈
    ti.remove();
    alert(err && err.message ? err.message : '发送失败，请稍后重试');
    return;
  }
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
    if (data.conversationReady) state.conversationReady = true;
    renderChatPhase();
  }
}

$('genReportBtn').addEventListener('click', generateReport);
async function generateReport() {
  const btn = $('genReportBtn');
  btn.disabled = true;
  let res, data;
  try {
    ({ res, data } = await api.post(`/api/session/${state.sessionId}/report`, {}));
  } catch (err) {
    btn.disabled = false;
    alert(err && err.message ? err.message : '报告生成失败，请稍后重试');
    return;
  }
  if (!res.ok) {
    alert(data?.error || '报告生成失败');
    btn.disabled = false;
    return;
  }
  state.reportReady = true;
  state.reportHtml = data.reportHtml || ''; // 保存报告正文，供报告页直接渲染
  state.conversationReady = false;
  state.meta = await getMeta();
  // 报告生成后，后端会在对话流追加追问；把追问消息也展示出来
  if (data.followup) {
    state.messages.push({ role: 'assistant', content: data.followup });
    appendMsgEl('ai', data.followup);
  }
  await loadReport();
  go('report');
}

// 对话页「下载报告」：直接触发对话整理 HTML 下载；未生成则提示
$('reportBtn').addEventListener('click', downloadConversation);

async function downloadConversation() {
  if (!state.conversationReady) {
    alert('暂无可下载的报告文件，请先回复是否需要整理对话');
    return;
  }
  const url = `/api/session/${state.sessionId}/conversation/download`;
  // 优先：同域直接链接下载（在用户点击手势内触发，浏览器原生处理下载，最稳）
  const a = document.createElement('a');
  a.href = url;
  a.download = `职业诊断对话记录_${state.sessionId}.html`;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 兜底：极少数浏览器拦截程序化下载时，回退到 fetch+blob 方式
  setTimeout(async () => {
    try {
      const { res } = await api.get(url);
      if (!res.ok) return;
      const blob = await res.blob();
      if (!blob || blob.size === 0) return;
      const bUrl = URL.createObjectURL(blob);
      const b = document.createElement('a');
      b.href = bUrl;
      b.download = a.download;
      document.body.appendChild(b);
      b.click();
      document.body.removeChild(b);
      setTimeout(() => URL.revokeObjectURL(bUrl), 60000);
    } catch {
      /* 兜底失败静默，主流程已尝试直接下载 */
    }
  }, 800);
}

// 报告页预览：优先展示「报告正文」（报告已生成即可看，不依赖对话整理 HTML）。
// 报告正文为空（极端异常）才显示空态提示；对话整理 HTML 仅用于「下载报告」按钮，不在此渲染。
async function loadReport() {
  const frame = $('reportFrame');
  const tip = $('reportTip');
  const html = state.reportHtml || '';
  if (!html) {
    if (tip) tip.style.display = 'block';
    if (frame) {
      const doc = frame.contentDocument || frame.contentWindow.document;
      if (doc) { doc.open(); doc.write(''); doc.close(); }
    }
    return;
  }
  if (tip) tip.style.display = 'none';
  const doc = frame.contentDocument || frame.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();
}

// 报告页「下载报告」：与对话页一致
$('openNew').addEventListener('click', downloadConversation);

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

let allUsers = [];
let userPage = 1;
const USER_PAGE_SIZE = 10;

async function loadAdmin() {
  const me = await api.get('/api/me');
  if (me.res.ok) $('adminPhone').textContent = maskPhone(me.data.phone);
  const { res, data } = await api.get('/api/admin/users');
  if (res.ok) {
    allUsers = data.users || [];
    if (!$('tab-list').hidden) renderUsersPage(userPage);
  } else if (res.status === 401) {
    api.clear();
    updateNav();
    go('login');
  } else if (res.status === 403) {
    alert('无管理员权限');
    go('home');
  }
}

function renderUsersPage(page) {
  const total = allUsers.length;
  const pages = Math.max(1, Math.ceil(total / USER_PAGE_SIZE));
  userPage = Math.min(Math.max(1, page), pages);
  const start = (userPage - 1) * USER_PAGE_SIZE;
  const slice = allUsers.slice(start, start + USER_PAGE_SIZE);
  const tb = $('userRows');
  tb.innerHTML = '';
  if (!slice.length) {
    tb.innerHTML = '<tr><td colspan="5" style="color:var(--ink-3)">暂无用户</td></tr>';
    $('userPager').innerHTML = '';
    return;
  }
  for (const u of slice) {
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
  const pager = $('userPager');
  pager.innerHTML = '';
  const prev = document.createElement('button');
  prev.className = 'mini-btn';
  prev.textContent = '上一页';
  prev.disabled = userPage <= 1;
  prev.onclick = () => renderUsersPage(userPage - 1);
  const info = document.createElement('span');
  info.className = 'pager-info';
  info.textContent = `共 ${total} 条 · 第 ${userPage}/${pages} 页`;
  const next = document.createElement('button');
  next.className = 'mini-btn';
  next.textContent = '下一页';
  next.disabled = userPage >= pages;
  next.onclick = () => renderUsersPage(userPage + 1);
  pager.append(prev, info, next);
}

function refreshUsers() {
  api.get('/api/admin/users').then(({ res, data }) => {
    if (res.ok) {
      allUsers = data.users || [];
      if (!$('tab-list').hidden) renderUsersPage(userPage);
    }
  });
}

function showAdminTab(name) {
  document.querySelectorAll('#adminTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $('tab-gen').hidden = name !== 'gen';
  $('tab-list').hidden = name !== 'list';
  $('tab-pwd').hidden = name !== 'pwd';
  if (name === 'list') renderUsersPage(userPage);
}

document.querySelectorAll('#adminTabs .tab').forEach((t) => {
  t.addEventListener('click', () => showAdminTab(t.dataset.tab));
});

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
    refreshUsers();
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
    refreshUsers();
  } else {
    alert(data?.error || '操作失败');
  }
}
async function adminRevoke(phone) {
  if (!confirm('确认作废该账号？作废后该密码将立即失效。')) return;
  const { res, data } = await api.post(`/api/admin/users/${phone}/revoke`, {});
  if (res.ok) refreshUsers();
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
  switchSampleTab('report');
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
    const [jr, dr, rr] = await Promise.all([
      fetch('/samples/shanda.json'),
      fetch('/samples/shanda-dialogue.html'),
      fetch('/samples/shanda-report.html'),
    ]);
    const s = await jr.json();
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
    // 对话节选 & 诊断报告：直接注入预生成的静态 HTML 片段（已用 H5 token 排版）
    $('sampleModalDialogue').innerHTML = await dr.text();
    $('sampleModalReport').innerHTML = await rr.text();
  } catch {
    /* 忽略 */
  }
}

// 样例弹层 Tab 切换：对话节选 / 诊断报告
function switchSampleTab(which) {
  document.querySelectorAll('.sample-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === which));
  $('sampleDlgPanel').hidden = which !== 'dlg';
  $('sampleReportPanel').hidden = which !== 'report';
  const btn = $('sampleSwitchBtn');
  if (btn) btn.textContent = which === 'dlg' ? '查看报告样例' : '查看对话节选';
  // 切换后回到弹窗顶部，方便用户从头阅读
  const modalEl = document.querySelector('#sampleMask .modal');
  if (modalEl) modalEl.scrollTop = 0;
}
document.querySelectorAll('.sample-tab').forEach((tab) => {
  tab.addEventListener('click', () => switchSampleTab(tab.dataset.tab));
});
// 底部联动按钮：点击切到另一个 Tab，并随当前 Tab 更新文案
$('sampleSwitchBtn').addEventListener('click', () => {
  const cur = $('sampleDlgPanel').hidden ? 'report' : 'dlg';
  switchSampleTab(cur === 'dlg' ? 'report' : 'dlg');
});

// ---------- 初始化 ----------
(async () => {
  await loadConfig();
  await fillSample();
  // 以 httpOnly Cookie 校验登录态（不再依赖 localStorage）
  const { res, data } = await api.get('/api/me');
  if (res.ok) {
    api.setSession('', data.role);
    updateNav();
    if (data.role === 'admin') {
      go('admin');
    } else {
      // 刷新后自动恢复最近有效会话；有历史进对话页，无则回首页
      const ok = await ensureSession({ autoCreate: false });
      if (ok) go('chat');
      else go('home');
    }
    return;
  }
  updateNav();
  go('home');
})();
