# 职业罗盘 H5 · 职业自我认知诊断（v2 鉴权版）

把 `hemo-career-compass` 这套职业诊断 Skill，包装成一个**独立 H5 网站**：用户通过一问一答完成职业自我认知诊断，并下载结构化诊断报告。本期为**封闭分发、账号登录鉴权**版本——去掉了 v1 的两道广告闸门，改为由管理员创建账号、用户凭账号登录后免费使用。

---

## 产品流程

```
首页（理念 / 诊断样例 / 诊断方式 / 隐私与安全 / 怎么开始）
   │ 点「开始诊断」→ 未登录则进入登录页
   ▼
登录页（手机号 + 图形验证码 + 10 位账号密码 + 勾选隐私协议）
   │ 管理员后台创建并线下发放账号
   ▼
诊断对话页（一问一答，每轮 ≤ 5000 字，后端调用大模型）
   │ 报告前不限轮次，登录用户免费
   ▼
点「生成报告」→ 后端生成《职业自我认知报告》
   ▼
报告页直接预览 / 下载（v2 已移除广告闸门）
   │ 报告生成后最多再追问 10 轮，之后禁言
   ▼
报告生成后 24 小时，服务端自动删除对话原文与报告文件
```

## 技术架构

- **前端**：原生 H5（HTML/CSS/JS 单页，ES Module），移动端优先，无构建步骤。编辑风设计语言（宣纸米白 / 墨黑 / 黛蓝）。
- **后端**：Node.js + Express，负责账号体系、JWT 鉴权、图形验证码、登录限流、会话状态、大模型调用、报告生成、数据清理。
- **鉴权基座**：零依赖实现——`crypto.scrypt` 做密码哈希、`crypto` 手写 HS256 JWT、内存 Map 做验证码与限流。
- **大模型**：**StepFun 阶跃星辰**（默认 `step-3.7-flash`，OpenAI 兼容 `/chat/completions`）。默认走真实模型；设置 `LLM_MOCK=true` 时启用内置演示兜底（无需联网，便于测试）。
- **Skill 提示词**：`server/skill/` 下复制自 `hemo-career-compass`（prompts / frameworks / referencers / references / research），运行时拼接为 system prompt；报告阶段按需注入用户所选参照系的事实依据。

## 目录结构

```
hemo-career-compass-program/
├── server/
│   ├── src/
│   │   ├── index.js         # Express 路由入口（装配鉴权/Admin/会话）
│   │   ├── config.js        # 配置（端口/大模型/业务规则/鉴权/限流）
│   │   ├── auth.js          # scrypt 哈希 + JWT 签发/校验 + 中间件
│   │   ├── captcha.js       # SVG 图形验证码（内存存储，5 分钟过期）
│   │   ├── users.js         # 账号体系（10 位密码 + JSON 存储 + 状态）
│   │   ├── ratelimit.js     # 手机号/IP 双维度滑动窗口限流
│   │   ├── skillLoader.js   # 拼接 system prompt + 报告指令
│   │   ├── llm.js           # LLM 调用（StepFun 真实优先，mock 仅兜底）
│   │   ├── store.js         # 会话存储（JSON 文件）+ 24h 清理
│   │   └── report.js        # Markdown → HTML（含打印样式）
│   ├── skill/               # 复制自 hemo-career-compass 的提示词
│   ├── test/                # 单元 + 集成测试（node --test）
│   ├── data/                # 运行时数据（users/sessions/reports/ratelimit，gitignore）
│   ├── .env.example         # 环境变量样例
│   └── package.json
└── web/                     # H5 前端
    ├── index.html           # 五视图单页（首页/登录/Admin/对话/报告）
    ├── samples/             # 固化诊断样例（脱敏）
    └── assets/{css,js}/     # tokens.css / style.css / api.js / app.js
```

## 快速开始（本地）

```bash
cd server
npm install
cp .env.example .env      # 填入 LLM_API_KEY 与 ADMIN_PHONE/ADMIN_PASSWORD
npm start                 # 默认 http://localhost:3001
```

浏览器打开 `http://localhost:3001`：
1. 用 `.env` 里的管理员手机 + 密码登录，进入「管理」页。
2. 在管理页输入一个测试手机号，点「生成密码」，拿到 10 位明文密码。
3. 退出，用该手机号 + 密码登录，即可开始诊断（对话由 StepFun 真实大模型驱动）。

> 测试无需联网：设置 `LLM_MOCK=true` 可走内置演示兜底。运行测试见下文。

## 环境变量（server/.env）

```bash
# 大模型（StepFun 阶跃星辰）
LLM_API_KEY=你的_stepfun_key          # 必填，获取：https://platform.stepfun.com/interface-key
LLM_BASE_URL=https://api.stepfun.com/v1
LLM_MODEL=step-3.7-flash
LLM_TEMPERATURE=0.8
LLM_MOCK=false                       # true=演示兜底；默认 false=真实大模型

# 鉴权（v2 新增）
JWT_SECRET=请换成随机长字符串         # 生产环境必改！用于签发 JWT
JWT_EXPIRES_HOURS=24                 # 登录态有效期
ADMIN_PHONE=13800000001              # 管理员手机号（首次启动写入存储）
ADMIN_PASSWORD=admin123456           # 管理员密码（首次启动写入存储，可在管理后台修改）
USER_PWD_TTL_HOURS=24                # 用户账号密码有效期（过期需管理员重新生成）

# 限流（v2 新增）
RATE_PHONE_MAX=5                     # 同手机号 24h 最多失败 5 次（允许 4 次，第 5 次封禁）
RATE_IP_MAX=10                       # 同 IP 24h 最多失败 10 次
RATE_WINDOW_HOURS=24

# 业务规则
PORT=3001
MAX_INPUT_CHARS=5000                 # 单轮输入上限
POST_REPORT_TURNS=10                 # 报告后追问轮次上限
REPORT_TTL_HOURS=24                  # 报告留存时长，超时自动删除
```

## 业务规则（v2 已落地）

- **封闭分发**：账号仅由管理员在后台创建并线下发放，不开放公开注册。
- **账号密码**：10 位 = 1 位数字 + 9 位大小写字母，排除歧义字符 `0/O/1/l/I`；24 小时内可复用，过期后需管理员重新生成。
- **登录**：手机号 + 图形验证码 + 密码三要素；图形验证码错误只拦截本次、不计数；手机/密码错误才计数；同手机号 24h≤5 次、同 IP 24h≤10 次失败限流（防枚举）。
- **JWT**：登录后签发 HS256 JWT（24h 有效期），前端 `localStorage` 存储 + `Authorization: Bearer`；服务端不维护黑名单，过期即失效。
- **输入限制**：诊断页每轮输入 ≤ 5000 字。
- **对话阶段**：报告前不限轮次，登录用户免费；报告生成后最多再追问 10 轮，用尽后禁言。
- **报告触发**：用户主动点「生成报告」按钮（每次诊断仅生成一次），生成后直接预览/下载，**无广告闸门**。
- **隐私删除**：报告生成后保留 24 小时供重复查看/下载，超时服务端自动清除对话与报告文件；未报告的会话 3 天未活动也会被清理。密码以哈希存储，服务端不留存明文。
- **参照系**：报告阶段根据用户所选参照系（大厂vs国企 / 考公 / 外企 / 创业 / 副业 / 教育路径）注入专属分析与事实依据。

## 测试

零额外依赖，使用 Node 内置 `node --test` 运行器：

```bash
cd server
# 单元测试（密码/哈希/JWT/验证码/限流/账号）
LLM_MOCK=true ADMIN_PHONE=13800000001 ADMIN_PASSWORD=admin123456 JWT_SECRET=test node --test test/unit.test.js
# 集成测试（登录全链路 / Admin / 会话 / 401-403 / 限流）
LLM_MOCK=true ADMIN_PHONE=13800000001 ADMIN_PASSWORD=admin123456 JWT_SECRET=test node --test test/integration.test.js
```

> 提示：测试会启动真实 HTTP 服务（随机端口）并读写 `server/data/`，运行前 `data/ratelimit.json` 等会被清理重建。

## 部署与迁移到小程序

- **H5 部署**：需备案 HTTPS 域名，将 `web/` 静态托管 + `server/` 后端部署到同一域名（或不同子域并配置 CORS）；部署前务必修改 `.env` 中的 `JWT_SECRET` 为随机长字符串。
- **迁移小程序**：前端逻辑（登录/对话/报告）与 UI 已组件化、与后端解耦。后续可用 uni-app / Taro 重写前端为一套代码出小程序；后端无需改动。注意个人主体小程序**不能**使用 `web-view` 与流量主广告，需办理**个体工商户营业执照**后方可接真实广告与微信支付。

## 成本参考

- 大模型调用约 ¥0.01–0.02 / 次诊断（StepFun `step-3.7-flash` + 提示词缓存后更低）。
- 固定成本：域名 ¥50–100/年 + 轻量服务器（¥60–120/年，单实例 JSON 存储即可支撑封闭分发规模）。
- 变现前置：个人号不能接广告/支付；需个体户主体 + 流量主 UV≥1000 门槛（v2 暂未接广告，先验证产品价值）。
