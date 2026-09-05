import crypto from 'node:crypto';
import https from 'node:https';
import { config } from './config.js';

// 阿里云邮件推送（DirectMail）SingleSendMail 调用封装。
// 无凭证或 EMAIL_MOCK=true 时走日志回显兜底，便于本地联调。

// RFC 3986 严格百分号编码：encodeURIComponent 基础上把 * 编码为 %2A（阿里云规范）
function percentEncode(s) {
  return encodeURIComponent(s)
    .replace(/\*/g, '%2A')
    .replace(/\+/g, '%20')
    .replace(/%7E/g, '~');
}

// 构造已签名的查询串（GET）
function buildSignedQuery(params, secret) {
  const keys = Object.keys(params).sort();
  const canon = keys.map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`).join('&');
  const stringToSign = `GET&${percentEncode('/')}&${percentEncode(canon)}`;
  const signature = crypto.createHmac('sha1', `${secret}&`).update(stringToSign).digest('base64');
  return `${canon}&Signature=${percentEncode(signature)}`;
}

// 是否已具备真实发送条件
export function isEmailReal() {
  return (
    config.emailMock !== true &&
    !!config.emailAccessKeyId &&
    !!config.emailAccessKeySecret &&
    !!config.emailFromAddress
  );
}

// 发送验证码邮件。返回 { ok, mock }；真实发送失败抛出 Error。
export function sendVerificationCode({ to, code }) {
  const subject = '职业罗盘 · 注册验证码';
  const text = `您的注册验证码为：${code}（10 分钟内有效，请勿告知他人）。`;
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;padding:20px;max-width:420px;margin:auto">
  <h3 style="color:#14202E;margin:0 0 12px">职业罗盘</h3>
  <p style="color:#333;font-size:14px;line-height:1.6">您的邮箱注册验证码：</p>
  <p style="font-size:28px;letter-spacing:6px;color:#14202E;margin:8px 0"><b>${code}</b></p>
  <p style="color:#666;font-size:13px">该验证码 10 分钟内有效。若非本人操作，请忽略此邮件，切勿将验证码告知他人。</p>
</div>`;

  if (!isEmailReal()) {
    console.log(
      `[EMAIL-MOCK] 向 ${to} 发送验证码：${code}（未真实发送，EMAIL_MOCK=true 或缺少阿里云凭证）`
    );
    return Promise.resolve({ ok: true, mock: true });
  }

  const params = {
    Format: 'JSON',
    Version: '2015-11-23',
    AccessKeyId: config.emailAccessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: '1.0',
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    RegionId: config.emailRegionId || 'cn-hangzhou',
    Action: 'SingleSendMail',
    AddressType: '1',
    ToAddress: to,
    FromAlias: config.emailFromAlias || '职业罗盘',
    Subject: subject,
    HtmlBody: html,
    TextBody: text,
    ReplyToAddress: 'false',
    AccountName: config.emailFromAddress, // SingleSendMail 的发信地址参数名为 AccountName（写成 MailAddress 会被忽略并报 AccountName is mandatory）
    ClickTrace: '0',
  };

  const query = buildSignedQuery(params, config.emailAccessKeySecret);
  const endpoint = config.emailEndpoint || 'dm.aliyuncs.com';
  const url = `https://${endpoint}/?${query}`;

  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.Code) {
            return reject(new Error(`邮件发送失败：${data.Message || data.Code}`));
          }
          resolve({ ok: true, mock: false, requestId: data.RequestId });
        } catch {
          reject(new Error('邮件服务返回无法解析的响应'));
        }
      });
    });
    req.on('error', (e) => reject(new Error(`邮件发送请求失败：${e.message}`)));
    req.setTimeout(8000, () => req.destroy(new Error('邮件发送超时')));
  });
}
