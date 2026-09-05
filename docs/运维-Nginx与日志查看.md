# 运维手册：Nginx 流式配置与日志查看

> 配套改造：流式化（P1）+ 静默超时（P2）+ Prompt 分层（P3）
> 对应方案：`docs/流式化与Prompt瘦身改造方案.md`

---

## 一、Nginx 配置（流式必需）

### ⚠️ 核心：必须关闭缓冲

SSE 流式最容易被反代"吃掉"。后端虽然已发送 `X-Accel-Buffering: no`，但**这只对 Nginx 的 `proxy_buffering` 生效于部分场景，仍需在 Nginx 侧显式关闭**，否则流式会被攒成一次性返回，首字延迟优势全部失效。

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    # ... SSL 证书配置 ...

    # 整体 gzip 保持开启即可，但 API 路径必须关闭（见下方 location）
    gzip on;
    gzip_types text/plain text/css application/json application/javascript;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;

        # ---------- 流式输出必需 ----------
        proxy_buffering off;          # 关键：不缓冲上游响应，SSE 才能逐帧下发
        proxy_cache off;              # 不缓存
        proxy_request_buffering off;  # 请求体也不缓冲
        chunked_transfer_encoding on;
        gzip off;                     # SSE 绝不能 gzip，否则同样会被攒包

        # ---------- 超时：模型生成可能持续数十秒到数分钟 ----------
        proxy_connect_timeout 10s;
        proxy_send_timeout   300s;
        proxy_read_timeout   300s;    # 必须远大于单次生成耗时

        # ---------- 标准转发头 ----------
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 与 proxy_http_version 1.1 配合，保持到上游的长连接
        proxy_set_header Connection "";
    }
}
```

修改后：

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 如果前面还挂了 CDN

腾讯云 CDN / Cloudflare 等同样可能缓冲。需为 `/api/` 路径关闭缓存与"智能压缩"，或将该路径设为**不经过 CDN 直连源站**。判断方法见下一节的 curl 验证。

---

## 二、验证流式是否真的生效

用 `curl -N`（`-N` = 禁用 curl 自身缓冲）观察帧是否**逐批到达**：

```bash
curl -N -X POST https://your-domain.com/api/session/<会话ID>/message/stream \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <你的token>" \
  -d '{"content":"我在考虑要不要换工作"}'
```

**判定标准**：

| 现象 | 结论 |
|---|---|
| `data: {"type":"delta"...}` 逐批刷出，最后才出现 `done` | ✅ 流式正常 |
| 停顿几十秒后一次性刷出全部内容 | ❌ 被 Nginx / CDN 缓冲了，检查上面配置 |

需要 token 时可先登录获取（`/api/auth/captcha` → `/api/auth/login`），或用浏览器 DevTools 的 Network 面板看该请求的 **EventStream** 标签页。

---

## 三、日志查看

### 3.1 日志在哪

应用日志落盘在 **`server/data/server.log`**（`index.js` 中 `console.log` / `console.error` 被拦截后同步追加写入）。

### 3.2 实时跟踪

```bash
# 直接看文件
tail -f server/data/server.log

# 若用 pm2 托管（stdout 同样会被 pm2 捕获）
pm2 logs <app-name>              # 实时跟踪
pm2 logs <app-name> --lines 200  # 先看最近 200 行
pm2 logs <app-name> --err        # 只看错误流
```

### 3.3 埋点字段说明

改造后每次模型调用都会打一行，格式示例：

```
[2026-09-05 03:33:13] [chat]         sid=0e173fb6 turns=3 promptChars=44050 totalMs=1820 chars=69
[2026-09-05 03:33:13] [report]       sid=0e173fb6 promptChars=52450 totalMs=9300 chars=1091
[2026-09-05 03:33:13] [chat-stream]  sid=0e173fb6 turns=3 promptChars=44050 firstTokenMs=820 totalMs=12400 chars=312
[2026-09-05 03:33:13] [report-stream] sid=0e173fb6 promptChars=52450 firstTokenMs=910 totalMs=41200 chars=1091
```

| 字段 | 含义 |
|---|---|
| `sid` | 会话 ID 前 8 位 |
| `turns` | 当前会话累计消息数 |
| `promptChars` | 本次注入的 system prompt 字符数（对话=44050，报告=52450） |
| `firstTokenMs` | **首字延迟**，`-1` 表示命中关键词兜底未调 LLM |
| `totalMs` | 总耗时 |
| `chars` | 产出文本长度 |

### 3.4 常用过滤命令

```bash
LOG=server/data/server.log

# 只看模型调用（4 类埋点）
grep -E '\[(chat|report|chat-stream|report-stream)\]' $LOG | tail -50

# 只看失败
grep '\[ERR\]' $LOG | tail -30

# 慢请求：总耗时 > 20s
grep 'totalMs=' $LOG | awk -F'totalMs=' '{split($2,a," "); if (a[1]+0 > 20000) print}'

# 首字延迟分布（样本数 / 最小 / 中位 / 最大）
grep -o 'firstTokenMs=[0-9]*' $LOG | cut -d= -f2 | sort -n \
  | awk '{a[NR]=$1} END{print "样本="NR, "最小="a[1]"ms", "中位="a[int(NR/2)]"ms", "最大="a[NR]"ms"}'

# 对比某个会话的完整链路
grep 'sid=0e173fb6' $LOG

# 启动时确认 Prompt 裁剪生效（应有「对话阶段削减=16.0%」）
grep '\[prompt\]' $LOG | tail -5
```

### 3.5 日志轮转（建议配置）

`server.log` 由应用自行 `appendFileSync` 追加，**没有内置轮转**，长期运行会持续增大。建议加 logrotate：

```conf
# /etc/logrotate.d/career-compass
/path/to/hemo-career-compass-program/server/data/server.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    dateext
}
```

> 用 `copytruncate` 是因为应用持有的是固定的文件路径句柄，直接 rename 会导致继续写旧文件。

验证：`sudo logrotate -d /etc/logrotate.d/career-compass`（dry-run）

---

## 四、回滚开关

| 场景 | 操作 | 影响 |
|---|---|---|
| 流式出问题 | `.env` 设 `LLM_STREAM=false` 并重启 | 降级为一次性返回，**前端无需改动**（SSE 协议不变） |
| Prompt 裁剪影响质量 | `.env` 设 `TRIM_CHAT_PROMPT=false` 并重启 | 对话阶段恢复全量注入（44050 → 52450 字符） |
| Nginx 缓冲无法关闭 | 设 `LLM_STREAM=false` | 退化为改造前行为，配合前端静默超时仍能避免误报 |

```bash
# 改完 .env 后重启
pm2 restart <app-name>
```

---

## 五、上线验收清单

- [ ] `curl -N` 验证 SSE 逐帧刷出（不是一次性返回）
- [ ] 启动时日志出现 `[prompt] 字符数 chat=44050 full=52450 对话阶段削减=16.0%`
- [ ] 对话日志出现 `firstTokenMs`，数值在 1–3s 量级（改造前是 30–90s）
- [ ] **移动端复现路径**：发消息 → 切到别的 App → 10s 后回浏览器
      - 期望：内容继续流出并最终完成，**不再弹「请求超时」**
- [ ] 报告生成页能看到「已生成 N 字」进度递增
- [ ] 中断网络后，已收到的部分内容不丢失，提示"刷新页面可获取完整回复"
- [ ] 刷新页面后对话与报告均可正常恢复
