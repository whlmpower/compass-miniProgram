// ===== 职业罗盘 H5 前端 · 网络层 =====
// JWT 存于后端下发的 httpOnly Cookie，fetch 自动携带（credentials:'include'）。
// 本模块不再读写 localStorage，且 token 仅存于模块作用域（非全局），XSS 无法窃取。

const api = {
  token: '', // 仅内存，不落盘（JWT 主载体是 httpOnly Cookie）
  role: '',
  authed: false,

  setSession(token, role) {
    this.token = token || '';
    this.role = role || '';
    this.authed = true;
  },

  // 前端登出：清内存态并通知后端清除 httpOnly Cookie（fire-and-forget，不阻塞 UI）
  clear() {
    this.token = '';
    this.role = '';
    this.authed = false;
    fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
  },

  async request(method, url, body) {
    const headers = {};
    let optsBody;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      optsBody = JSON.stringify(body);
    }
    const res = await fetch(url, { method, headers, body: optsBody, credentials: 'include' });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* 非 JSON 响应（如下载文件） */
    }
    return { res, data };
  },

  get(url) {
    return this.request('GET', url);
  },
  post(url, body) {
    return this.request('POST', url, body);
  },
  put(url, body) {
    return this.request('PUT', url, body);
  },
};

export { api };
