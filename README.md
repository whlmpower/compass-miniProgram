# 职业罗盘 H5 · 职业自我认知诊断（MVP）

把 `hemo-career-compass` 这套职业诊断 Skill，包装成一个**独立 H5 网站**：用户通过一问一答完成职业自我认知诊断，并下载结构化诊断报告。本期为可独立上线的 H5 版本，后端与前端解耦，后续可平滑迁移到微信小程序。

---

## 产品流程

```
首页（理念/技术/样例/隐私协议 + 勾选）
   │ 勾选隐私协议 → 开始诊断
   ▼
观看 10 秒广告（入口闸门，看完才解锁）
   ▼
诊断对话页（一问一答，每轮 ≤ 5000 字，后端调用大模型）
   │ 报告前不限轮次
   ▼
点「生成报告」→ 后端生成《职业自我认知报告》
   ▼
点「查看/下载报告」→ 再看 10 秒广告（下载闸门）→ 解锁 → 打开报告页（可打印/存 PDF）
   │ 报告生成后最多再追问 10 轮，之后禁言
   ▼
报告生成后 24 小时，服务端自动删除对话原文与报告文件
```

## 技术架构

- **前端**：原生 H5（HTML/CSS/JS 单页），移动端优先，无构建步骤。
- **后端**：Node.js + Express，负责会话状态、调用大模型 API、报告生成、广告解锁状态、数据清理。
- **大模型**：**StepFun 阶跃星辰**（默认 `step-3.7-flash`，OpenAI 兼容 `/chat/completions`）。默认走真实模型；设置 `LLM_MOCK=true` 时启用内置演示兜底（无需联网）。
- **Skill 提示词**：`server/skill/` 下复制自 `hemo-career-compass`（prompts / frameworks / referencers / references / research），运行时拼接为 system prompt 喂给模型；报告阶段按需注入用户所选参照系的事实依据。

## 目录结构

```
hemo-career-compass-program/
├── server/
│   ├── src/
│   │   ├── index.js         # Express 路由入口
│   │   ├── config.js        # 配置（端口/大模型/业务规则）
│   │   ├── skillLoader.js   # 拼接 system prompt + 报告指令
│   │   ├── llm.js           # LLM 调用（StepFun 真实优先，mock 仅兜底）
│   │   ├── store.js         # 会话存储（JSON 文件）+ 24h 清理
│   │   └── report.js        # Markdown → HTML（含打印样式）
│   ├── skill/               # 复制自 hemo-career-compass 的提示词
│   ├── data/                # 运行时数据（会话/报告，gitignore）
│   └── package.json
└── web/                     # H5 前端
    ├── index.html
    └── assets/{css,js}/
```

## 快速开始（本地）

```bash
cd server
npm install
npm start            # 默认 http://localhost:3001 （读取 server/.env，真实大模型已启用）
```

浏览器打开 `http://localhost:3001` 即可体验完整流程（对话由 StepFun 真实大模型驱动）。

## 大模型配置（StepFun 阶跃星辰）

密钥与模型参数通过 `server/.env`（已 gitignore）注入，由 `dotenv` 自动加载。复制 `server/.env.example` 为 `server/.env` 并填入你的 Key 即可：

```bash
# server/.env
LLM_API_KEY=你的_stepfun_key          # 必填，获取：https://platform.stepfun.com/interface-key
LLM_BASE_URL=https://api.stepfun.com/v1
LLM_MODEL=step-3.7-flash             # 默认快模型；可换 step-1 / step-2 等更强模型
LLM_TEMPERATURE=0.8
LLM_MOCK=false                       # true=演示兜底（无需联网）；默认 false=真实大模型
# 可选
PORT=3001
MAX_INPUT_CHARS=5000                 # 单轮输入上限
POST_REPORT_TURNS=10                 # 报告后追问轮次上限
REPORT_TTL_HOURS=24                  # 报告留存时长，超时自动删除
```

## 业务规则（已落地）

- **两道广告闸门**：进入诊断前、下载报告前各需观看 10 秒广告，看完才解锁（MVP 为模拟广告倒计时）。
- **输入限制**：诊断页每轮输入 ≤ 5000 字。
- **对话阶段**：报告前不限轮次；报告生成后最多再追问 10 轮，用尽后禁言。
- **报告触发**：用户主动点「生成报告」按钮（每次诊断仅生成一次）。
- **隐私删除**：报告生成后保留 24 小时供重复查看/下载，超时服务端自动清除对话与报告文件；未报告的会话 3 天未活动也会被清理。
- **参照系**：报告阶段根据用户所选参照系（大厂vs国企 / 考公 / 外企 / 创业 / 副业 / 教育路径）注入专属分析与事实依据。

## 部署与迁移到小程序

- **H5 部署**：需备案 HTTPS 域名，将 `web/` 静态托管 + `server/` 后端部署到同一域名（或不同子域并配置 CORS）。
- **迁移小程序**：前端逻辑（对话/广告/报告）与 UI 已组件化、与后端解耦。后续可用 uni-app / Taro 重写前端为一套代码出小程序；后端无需改动。注意个人主体小程序**不能**使用 `web-view` 与流量主广告，需办理**个体工商户营业执照**后方可接真实广告与微信支付。

## 成本参考

- 大模型调用约 ¥0.01–0.02 / 次诊断（StepFun `step-3.7-flash` + 提示词缓存后更低）。
- 固定成本：域名 ¥50–100/年 + 轻量服务器/Serverless（近乎免费起）。
- 变现前置：个人号不能接广告/支付；需个体户主体 + 流量主 UV≥1000 门槛。
