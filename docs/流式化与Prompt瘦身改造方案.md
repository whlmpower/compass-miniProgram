# 降低根因延迟改造方案

> 背景：移动端「发消息 → 切后台 → 回前台」必现「请求超时，服务可能未启动或响应过慢」。
> 已验证：超时后刷新页面，回复正常出现 → **服务端健康，纯前端误报**。
> 根因：前端 60s 硬超时 + 移动端切后台定时器冻结 + 每轮预填 3 万 token 导致生成慢。
> 本方案从**降低根因延迟**入手，不依赖放宽超时来掩盖问题。

---

## 一、现状量化（实测数据）

### 1.1 system prompt 构成

`buildSystemPrompt()` 实测 **51,919 字符 ≈ 2.6 万 ~ 3.5 万 tokens**，且**每一轮对话都全量重发**。

| 文件 | 字符数 | 占比 |
|---|---:|---:|
| prompts/system.md | 6,971 | 13.4% |
| prompts/dimensions.md | 4,954 | 9.5% |
| references/insights.md | 4,267 | 8.2% |
| prompts/warmup.md | 2,543 | 4.9% |
| prompts/socratic.md | 2,641 | 5.1% |
| prompts/jailbreak.md | 2,277 | 4.4% |
| prompts/synthesize.md | 2,080 | 4.0% |
| prompts/reference-select.md | 1,724 | 3.3% |
| **核心 prompts 小计** | **27,457** | **52.9%** |
| frameworks/scoring-rubrics.md | 5,548 | 10.7% |
| frameworks/schwartz.md | 5,015 | 9.7% |
| frameworks/weights.md | 2,778 | 5.4% |
| frameworks/family-anchor.md | 2,686 | 5.2% |
| frameworks/schein.md | 2,545 | 4.9% |
| frameworks/attachment.md | 2,086 | 4.0% |
| frameworks/risk-tolerance.md | 2,076 | 4.0% |
| frameworks/bigfive.md | 1,728 | 3.3% |
| **frameworks 小计** | **24,462** | **47.1%** |
| **合计** | **51,919** | 100% |

### 1.2 关键发现：设计意图与实现脱节

`server/skill/prompts/system.md` 第 313–323 行**已经定义了一张按需加载索引表**：

```
| `frameworks/bigfive.md`       | 大五人格框架   | 展开维度A时 |
| `frameworks/schein.md`        | 施恩职业锚框架 | 展开维度B时 |
| `frameworks/scoring-rubrics.md` | 评分锚定量表 | 需要评分时  |
| `frameworks/weights.md`       | 动态权重矩阵   | 综合诊断时  |
| `references/insights.md`      | 金句库         | 需要引用金句时 |
```

但 `skillLoader.js:38-49` 的 `buildSystemPrompt()` **无条件全量拼接**，完全无视这张表。

> 结论：**不是要重新设计按需加载，而是把已有设计落地**。这大幅降低了方案风险。

### 1.3 调用链路现状

| 环节 | 位置 | 现状 |
|---|---|---|
| LLM 调用 | `server/src/llm.js:17` | 单次 `fetch` 等完整结果，**无流式、无超时、无重试** |
| system prompt | `server/src/index.js:115` | 启动时算一次，全局复用 |
| 对话接口 | `index.js:353-400` | 同步等待，一次性返回 |
| 报告接口 | `index.js:402-426` | 同步等待（输出更长，更慢） |
| 前端超时 | `web/assets/js/api.js:34` | 60s 硬 abort |
| 页面生命周期 | `web/assets/js/` | `visibilitychange`/`focus` 监听 **为 0** |
| 超时后补偿 | `app.js:328` | 仅删气泡 + alert，**无补偿** |

### 1.4 有利条件（已确认）

- 后端**无 compression 中间件** → SSE 不会被 gzip 缓冲
- CSP 未显式限制 `connect-src`，回落到 `default-src 'self'` → 同源流式请求可用
- 已有 `server/data/server.log` 日志落盘（`index.js:47`），便于埋点量化

---

## 二、改造主线

### 主线 A：流式化（SSE）—— 治本

**目标**：首字延迟从 30–90s 降到 1–3s。

#### A1. `llm.js` 新增流式接口

新增 `chatStream(systemPrompt, history, { onDelta, extraSystem, temperature })`：

- `fetch` 增加 `stream: true`
- 读取 `resp.body` 的 `ReadableStream`，按 SSE 帧解析 `data: {...}`，取 `choices[0].delta.content` 回调 `onDelta`
- **保留现有 `chat()` 不删除**：mock 模式、报告生成、兜底路径继续用

#### A2. 后端新增流式路由

新增 `POST /api/session/:id/message/stream`。

**协议选型：POST + fetch ReadableStream（不用 EventSource）**
理由：EventSource 不支持 POST body，而本接口需带 `content` 且走 `credentials:'include'`。

响应头（缺一不可）：

```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no      ← 关键：禁用 Nginx 缓冲
```

帧格式：

```
data: {"type":"delta","text":"..."}
data: {"type":"done","reply":"...","conversationReady":false,"postReportTurnsLeft":10}
data: {"type":"error","message":"..."}
```

> ⚠️ **部署注意**：若生产前有 Nginx 反代，必须同时配置 `proxy_buffering off;`，否则 `X-Accel-Buffering: no` 之外仍可能被缓冲，流式会退化成一次性返回。

#### A3. 前端改造

- `api.js` 新增 `postStream(url, body, { onDelta })`：`response.body.getReader()` + `TextDecoder` 逐帧解析
- `app.js` `sendMessage()`：把「思考中…」气泡改为**边收边渲染**

渲染策略（重要，避免卡顿和闪烁）：

1. 流式过程中用**纯文本**渲染（`textContent`），不走 Markdown 解析
2. 增量刷新做节流：**每 80–120ms 或每 30 字符**刷新一次，避免每个 token 都触发 `marked.parse` + `DOMPurify.sanitize`
3. 流结束后再走一次 `renderMarkdown()` 定稿，避免半截 Markdown 语法（如未闭合的 `**`）闪烁

#### A4. 顺带解决「切后台冻结」

流式化后，超时语义可以升级为**静默超时**：

> 只要持续收到数据就重置计时器；**连续 60s 无任何数据**才判定超时。

这样切后台再回来，只要服务端一直在推进，回来后继续收流即可，**天然免疫定时器冻结问题**。

---

### 主线 B：Prompt 按需注入 —— 削减预填

#### B1. 分层模型

| 层 | 内容 | 字符 | 注入时机 |
|---|---|---:|---|
| L0 常驻 | system.md, dimensions.md, socratic.md, jailbreak.md | 16,843 | 每轮 |
| L1 阶段 | warmup.md, reference-select.md, synthesize.md | 6,347 | 对应阶段 |
| L2 维度框架 | bigfive / schein / schwartz / attachment / risk-tolerance / family-anchor | 16,136 | 展开该维度时 |
| L3 评分 | scoring-rubrics.md, weights.md | 8,326 | **仅报告阶段** |
| L4 金句 | references/insights.md | 4,267 | 按需 / 报告阶段 |

#### B2. 三档方案

**方案 B-保守（推荐先做）**

- 仅把 L3 评分层（8,326 字符，**−16%**）移出对话阶段
- 对话阶段：51,919 → 43,593 字符
- 依据：`system.md` 明确标注 scoring-rubrics 是「需要评分时」、weights 是「综合诊断时」，**对话阶段本就用不到**
- 风险：极低

**方案 B-激进**

- 在 B-保守基础上，再移出 L2 六框架（16,136 字符），仅在报告阶段注入
- 对话阶段：43,593 → **27,457 字符（累计 −47%）**
- 依据：`dimensions.md` 已内联各框架精简版（施恩职业锚 8 型、施瓦茨价值观 10 型、依恋 3 型均已列出），足以支撑提问
- 风险：中 —— 维度探测精准度可能下降，**需 AB 对比验证**

**方案 B-理想（最贴合原始设计）**

- 会话状态增加 `activeDimension`
- 由 LLM 在回复中用轻量标记声明当前探查的维度（如 `<!--dim:B-->`），服务端解析后下一轮只注入对应框架
- 或按轮次粗粒度切换：暖启动 → 参照系 → 维度 A–F → 综合
- 改动最大，但完全落地 `system.md` 的按需加载索引表

#### B3. 历史对话瘦身（可选）

除 system prompt 外，每轮还重发完整 `s.messages`，轮次多了同样是大头：

- 超过 N 轮后，对早期对话做 LLM 摘要压缩
- 或对已完成的维度，把该维度多轮问答压缩为一段结构化结论

#### B4. 实现注意点

> ⚠️ `index.js:115` 的 `const sysPrompt = buildSystemPrompt()` 是**模块级、启动时算一次**。
> 改为按阶段/维度构建后，必须加**按 key 缓存**（如 `Map<phase, string>`），否则每轮都读 16 个文件 + 拼接，反而引入新的 IO 开销。

---

## 三、实施顺序

四个阶段**可独立上线、可独立回滚**：

| 阶段 | 内容 | 收益 | 风险 | 回滚方式 |
|---|---|---|---|---|
| **P1** | 流式化（SSE + 前端增量渲染） | 首字 30–90s → 1–3s，**根治超时误报** | 中 | `LLM_STREAM=false` 秒回退非流式 |
| **P2** | 超时语义升级为「静默超时」 | 免疫切后台冻结 | 低 | 独立，前端单点 |
| **P3** | Prompt 分层：L3 移出对话阶段 | −16% 预填 token | 低 | 配置开关 |
| **P4** | Prompt 分层：L2 按需注入 | 累计 −47% 预填 token | 中（需 AB 验证） | 配置开关 |

**建议**：P1 + P3 合并做一个迭代（收益叠加、回归面可控），P2 顺带带上，P4 单独一轮验证质量。

---

## 四、需要确认的决策点

1. **协议选型**：POST + fetch ReadableStream（推荐）还是 GET + EventSource？
2. **迭代范围**：P1（流式）+ P3（L3 瘦身）一起做，还是只先做 P1？
3. **部署拓扑**：生产是 Nginx 反代还是 Node 直接暴露？若走 Nginx 需同步配 `proxy_buffering off`
4. **埋点**：是否加「各阶段 prompt token 数 / 首字延迟 / 总耗时」日志，便于量化验证改造效果？

---

## 五、验证方式

1. **日志量化**：在 `server/data/server.log` 记录每轮的首字延迟、总耗时、prompt 字符数，改造前后对比
2. **移动端复现路径回归**：
   - 发消息 → 立即切后台 → 10s 后回前台
   - **期望**：内容继续流出并最终完成，**不再弹超时**
3. **质量回归**（针对 P4）：同一份对话脚本，对比全量注入与按需注入两份报告，人工评估维度覆盖度与洞察质量
4. **降级验证**：`LLM_STREAM=false` 时，流程仍能正常走通非流式路径
