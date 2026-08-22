import crypto from 'node:crypto';

// 图形验证码：服务端生成、绑定 captchaId、5 分钟过期、先校验再放行密码校验
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 排除易混字符（0/O/1/I/l）
const TTL = 5 * 60 * 1000;
const WIDTH = 120;
const HEIGHT = 46;

// captchaId -> { answer, expireAt }（内存存储，重启清零，可接受）
const MAP = new Map();

export function generateCaptcha() {
  const captchaId = crypto.randomUUID();
  let answer = '';
  for (let i = 0; i < 4; i++) {
    answer += CHARSET[Math.floor(Math.random() * CHARSET.length)];
  }
  MAP.set(captchaId, { answer, expireAt: Date.now() + TTL });
  sweep();
  return { captchaId, svg: renderSvg(answer) };
}

export function verifyCaptcha(captchaId, input) {
  if (!captchaId || typeof input !== 'string') return false;
  const rec = MAP.get(captchaId);
  if (!rec) return false;
  if (Date.now() > rec.expireAt) {
    MAP.delete(captchaId);
    return false;
  }
  const ok = rec.answer.toLowerCase() === input.trim().toLowerCase();
  if (ok) MAP.delete(captchaId); // 一次性消费，防止重放
  return ok;
}

function sweep() {
  const now = Date.now();
  for (const [k, v] of MAP) {
    if (now > v.expireAt) MAP.delete(k);
  }
}

function renderSvg(answer) {
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`;
  svg += `<rect width="${WIDTH}" height="${HEIGHT}" fill="#EDE8DC"/>`;
  // 干扰线
  for (let i = 0; i < 4; i++) {
    const x1 = (Math.random() * WIDTH).toFixed(1);
    const y1 = (Math.random() * HEIGHT).toFixed(1);
    const x2 = (Math.random() * WIDTH).toFixed(1);
    const y2 = (Math.random() * HEIGHT).toFixed(1);
    svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="rgba(43,58,94,0.18)" stroke-width="1"/>`;
  }
  // 字符：黛蓝系，轻微色相扰动 + 旋转，防机器识别
  for (let i = 0; i < 4; i++) {
    const x = (16 + i * 24).toFixed(1);
    const y = (30 + Math.random() * 6).toFixed(1);
    const rot = (Math.random() * 30 - 15).toFixed(1);
    const sz = (20 + Math.random() * 4).toFixed(0);
    const hue = (218 + (Math.random() * 16 - 8)).toFixed(0);
    const color = `hsl(${hue}, 36%, 32%)`;
    svg += `<text x="${x}" y="${y}" font-family="Noto Serif SC, serif" font-size="${sz}" font-weight="600" fill="${color}" transform="rotate(${rot} ${x} ${y})">${answer[i]}</text>`;
  }
  svg += `</svg>`;
  return svg;
}
