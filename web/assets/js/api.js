// ===== 职业罗盘 H5 前端 · 网络层 =====
// 统一封装 fetch + Bearer 鉴权；401 时由调用方决定跳转登录。

const api = {
  token: localStorage.getItem('hcc_token') || '',
  role: localStorage.getItem('hcc_role') || '',

  setSession(token, role) {
    this.token = token;
    this.role = role;
    localStorage.setItem('hcc_token', token);
    localStorage.setItem('hcc_role', role);
  },

  clear() {
    this.token = '';
    this.role = '';
    localStorage.removeItem('hcc_token');
    localStorage.removeItem('hcc_role');
  },

  async request(method, url, body) {
    const headers = {};
    if (this.token) headers['Authorization'] = 'Bearer ' + this.token;
    const opts = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
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
