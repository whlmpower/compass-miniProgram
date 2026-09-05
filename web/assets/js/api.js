// ===== 职业罗盘 H5 前端 · 网络层 =====
// JWT 存于后端下发的 httpOnly Cookie，fetch 自动携带（credentials:'include'）。
// 本模块不再读写 localStorage，且 token 仅存于模块作用域（非全局），XSS 无法窃取。

// 非流式请求超时：超时或连接被拒都会 reject，避免 UI 无限“思考中”
const REQUEST_TIMEOUT_MS = 60000;

// 流式请求「静默超时」（P2）：只要持续收到数据就重置计时器，
// 连续 60s 无任何数据才判定失败。这样切后台再回前台不会误杀仍在进行中的请求
// ——移动端切后台会冻结 setTimeout，回前台后总时长可能早已超过 60s，
// 旧的总时长超时会在此时“补刀”abort，丢弃服务端已完成的响应。
const STREAM_IDLE_TIMEOUT_MS = 60000;

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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: optsBody,
        credentials: 'include',
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      // 连接被拒 / 超时 / 网络异常：抛出带语义的错误，交由调用方兜底 UI
      const reason = err && err.name === 'AbortError' ? '请求超时，服务可能未启动或响应过慢' : '无法连接服务，请确认服务是否已启动';
      throw new Error(reason);
    }
    clearTimeout(timer);
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* 非 JSON 响应（如下载文件） */
    }
    return { res, data };
  },

  // ---------- 流式请求（P1 主线 A） ----------
  // 读取 SSE 帧：data: {"type":"delta","text":"..."} / {"type":"done",...} / {"type":"error",...}
  // onDelta(text) 每收到一段增量文本回调一次；返回 done 帧携带的完整对象。
  async postStream(url, body, { onDelta } = {}) {
    const controller = new AbortController();
    let timer = null;
    // 静默超时：每收到一批数据就重新计时
    const armIdle = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), STREAM_IDLE_TIMEOUT_MS);
    };
    armIdle();

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body === undefined ? {} : body),
        credentials: 'include',
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new Error(
        err && err.name === 'AbortError'
          ? '模型长时间无响应，请检查网络后重试'
          : '无法连接服务，请确认服务是否已启动'
      );
    }

    if (!res.ok || !res.body) {
      clearTimeout(timer);
      let msg = `请求失败（${res.status}）`;
      try {
        const j = await res.json();
        if (j && j.error) msg = j.error;
      } catch {
        /* 非 JSON 响应，保留默认提示 */
      }
      const e = new Error(msg);
      e.status = res.status;
      throw e;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    let done = null;
    let streamError = null;

    try {
      for (;;) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        armIdle(); // 收到数据 → 重置静默计时器
        buf += decoder.decode(value, { stream: true });
        // SSE 帧以空行分隔；保留末尾不完整的半帧到下一轮
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const raw of frame.split('\n')) {
            const line = raw.trim();
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            let obj;
            try {
              obj = JSON.parse(payload);
            } catch {
              continue; // 忽略无法解析的帧，不中断整体流
            }
            if (obj.type === 'delta') {
              if (typeof onDelta === 'function' && obj.text) onDelta(obj.text);
            } else if (obj.type === 'done') {
              done = obj;
            } else if (obj.type === 'error') {
              streamError = obj.message || '生成失败';
            }
          }
        }
      }
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error('模型长时间无响应，请检查网络后重试');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (streamError) throw new Error(streamError);
    if (!done) throw new Error('响应未正常结束，请刷新页面查看完整内容');
    return done;
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
