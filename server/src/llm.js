import { config, isMock } from './config.js';

export async function chat(
  systemPrompt,
  history,
  { temperature = config.llmTemperature, extraSystem = '' } = {}
) {
  if (isMock()) return mockChat(history);
  return openaiChat(systemPrompt, history, temperature, extraSystem);
}

async function openaiChat(systemPrompt, history, temperature, extraSystem) {
  if (!config.llmApiKey) {
    throw new Error('未配置 LLM_API_KEY，且未开启 LLM_MOCK，无法调用真实大模型');
  }
  const sysContent = extraSystem ? `${systemPrompt}\n\n${extraSystem}` : systemPrompt;
  const resp = await fetch(`${config.llmBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.llmApiKey}`,
    },
    body: JSON.stringify({
      model: config.llmModel,
      temperature,
      messages: [{ role: 'system', content: sysContent }, ...history],
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`LLM API error ${resp.status}: ${t}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

// ---------- Mock 模式：无需 API Key 即可演示完整诊断流程 ----------
function mockChat(history) {
  const userTurns = history.filter((m) => m.role === 'user').length;
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  const lastText = lastUser ? lastUser.content : '';

  if (userTurns === 0) {
    return '我是职业罗盘——一面犀利、直接、不回避矛盾的镜子。\n\n先别急着要答案。告诉我：是什么让你现在开始认真想这件事？最近一次让你对「职业方向」感到纠结，是在什么具体场景下？多讲讲当时发生了什么。';
  }

  const replies = [
    `你刚才提到「${lastText.slice(0, 12)}…」，我注意到你用了很多形容词，但还没给我一个具体的事。能不能举一个真实例子——某次让你特别有感触的经历，当时你做了什么、结果如何？`,
    `听起来这件事对你很重要。我想再逼你一下：你说你「想要稳定／成长」，如果把这两个词换成具体画面——你理想里典型的一天是什么样的？越具体越好。`,
    `你描述的这两个渴望其实在拉扯。我好奇：如果必须二选一，哪个让你更害怕失去？这个「更怕」里，藏着你真正在乎的东西。`,
    `先停一下。你刚才的回答，有多少是「你真正想要的」，有多少是「别人（父母／社会／同龄人）觉得你该要的」？试着把它们分开说。`,
    `很好，比刚才具体多了。顺着这个例子再走一步：当时那个选择，你纠结的点到底是什么——是怕后果，还是怕辜负谁？`,
  ];
  return replies[userTurns % replies.length];
}

// 演示用示例报告（结构合规，接入真实模型后会被个性化内容替代）
export function mockReport() {
  return `# 职业自我认知报告

> ⚠️ 重要声明
>
> 本报告由 AI 生成，基于对话内容和心理学理论框架，不构成职业咨询或心理咨询建议。
>
> 本报告旨在帮助你更好地认识自己，而不是替你做决定。如果你的职业选择伴随严重的焦虑、抑郁或心理困扰，建议寻求专业心理咨询师的帮助。
>
> 如果你正在经历危机，请联系：北京心理危机研究与干预中心 010-82951332 / 生命热线 400-821-1215

## 1. 你的职业人格画像
你的核心驱动力是「在不确定中证明自己」。

- **探索者**：你渴望看见不一样的可能性，而不是被安排好的路径。
- **矛盾体**：你既想要安全感，又恐惧一眼望到头；这两股力量在你身上共存。
- **证据型思考者**：你不太相信道理，只相信自己经历过的例子。

## 2. 内心世界地图（雷达图）
| 维度 | 当前位置 | 真实渴望 | 矛盾冲突 | 潜在盲区 |
|---|---|---|---|---|
| 成就驱动力 | 高 | 高 | 在乎被看见 | 用「不在乎」自我保护 |
| 安全需求 | 中 | 中 | 想要托底 | 把稳定等同于不成长 |
| 自主性 | 高 | 高 | 怕被管理 | 低估协作价值 |
| 社会影响力 | 中 | 中 | 想被认可 | 羞于承认 |
| 成长速度 | 高 | 高 | 怕落后 | 忽视深耕 |
| 工作生活边界 | 中 | 中 | 想要掌控 | 容易入侵生活 |

\`\`\`mermaid
radarChart
    title 职业自我认知雷达图
    axis 成就驱动力, 安全需求, 自主性, 社会影响力, 成长速度, 工作生活边界
    axis 当前状态: 80, 50, 85, 55, 80, 50
    axis 真实渴望: 85, 50, 90, 60, 85, 55
\`\`\`

## 3. 关键发现
**发现1：你最大的矛盾是「想要稳定，但恐惧无聊」。** 你说求稳，但你的高光时刻都发生在跳出舒适区时。你怕的不是不稳定，而是一眼望到头。

**发现2：你的「自主性」被低估了。** 你以为自己在意认可，但真正让你 energized 的，是「我自己说了算」的时刻。

## 4. 下一步建议
- 给自己一个月「小实验」：每天记录 3 个 alive 和 3 个麻木的时刻。
- 重新定义稳定：不是「不失业」，而是「我有选择的权利」。
- 接受矛盾，不必现在二选一。

> （示例报告 · 当前为演示模式，接入真实大模型后将基于你的真实对话生成个性化内容。）
`;
}
