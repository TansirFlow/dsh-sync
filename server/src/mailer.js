/**
 * 邮件通知：新会话开启时给目标邮箱发一封带免登录链接的通知。
 */

import nodemailer from 'nodemailer'
import { config } from './config.js'

let transporter = null

function getTransporter() {
  if (transporter) return transporter
  if (!config.mailEnabled) return null
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
    // Zoho 对频繁发信敏感，放慢并复用连接。
    pool: true,
    maxConnections: 2,
    maxMessages: 50,
  })
  return transporter
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function truncate(s, n = 300) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/**
 * 发送新会话通知。
 * @param {object} opts
 * @param {string|string[]} opts.to - 单个或多个收件地址
 * @returns {Promise<{ok: boolean, error?: string, messageId?: string, to: string[]}>}
 */
export async function sendSessionNotification({ to, session, shareUrl, preview, firstUserMessage }) {
  const tx = getTransporter()
  const recipients = (Array.isArray(to) ? to : [to]).map((s) => String(s ?? '').trim()).filter(Boolean)
  if (!tx) return { ok: false, error: '邮件功能已禁用', to: recipients }
  if (recipients.length === 0) return { ok: false, error: '收件人为空', to: [] }

  const title = session.title || '未命名会话'
  const subject = `[DSH] 新会话：${truncate(title, 60)}`
  const started = new Date(session.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
  const body = preview || firstUserMessage || '（暂无内容预览）'

  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
        <tr><td style="background:#1f6feb;padding:20px 28px;">
          <div style="color:#ffffff;font-size:17px;font-weight:600;">DeepSeek Harness</div>
          <div style="color:#c9dcff;font-size:13px;margin-top:2px;">新的对话已开启</div>
        </td></tr>
        <tr><td style="padding:28px;">
          <div style="font-size:19px;font-weight:600;color:#111827;line-height:1.4;">${escapeHtml(title)}</div>
          <div style="margin-top:14px;font-size:13px;color:#6b7280;line-height:1.9;">
            <div><strong style="color:#374151;">开始时间：</strong>${escapeHtml(started)}</div>
            <div><strong style="color:#374151;">工作目录：</strong><code style="background:#f3f4f6;padding:1px 6px;border-radius:4px;">${escapeHtml(session.cwd || '-')}</code></div>
            <div><strong style="color:#374151;">归属账号：</strong>${escapeHtml(session.ownerEmail || '-')}</div>
          </div>
          <div style="margin-top:20px;padding:14px 16px;background:#f9fafb;border-left:3px solid #1f6feb;border-radius:6px;font-size:14px;color:#374151;line-height:1.7;white-space:pre-wrap;">${escapeHtml(truncate(body, 400))}</div>
          <div style="margin-top:26px;text-align:center;">
            <a href="${escapeHtml(shareUrl)}" style="display:inline-block;background:#1f6feb;color:#ffffff;text-decoration:none;padding:12px 30px;border-radius:8px;font-size:15px;font-weight:600;">查看完整聊天记录</a>
          </div>
          <div style="margin-top:18px;font-size:12px;color:#9ca3af;line-height:1.6;text-align:center;">
            此链接含访问凭证，请勿转发给他人。<br>
            链接在 ${config.shareTtlDays} 天后失效。
          </div>
        </td></tr>
      </table>
      <div style="margin-top:16px;font-size:11px;color:#9ca3af;">由 DSH Sync 自动发送</div>
    </td></tr>
  </table>
</body></html>`

  const text = `DeepSeek Harness 新会话通知

标题：${title}
开始时间：${started}
工作目录：${session.cwd || '-'}
归属账号：${session.ownerEmail || '-'}

预览：
${truncate(body, 400)}

查看完整聊天记录：${shareUrl}

此链接含访问凭证，请勿转发。链接在 ${config.shareTtlDays} 天后失效。`

  try {
    const info = await tx.sendMail({
      from: config.smtp.from || config.smtp.user,
      to: recipients.join(', '),
      subject,
      text,
      html,
    })
    return { ok: true, messageId: info.messageId, to: recipients }
  } catch (err) {
    return { ok: false, error: `${err.code || err.name}: ${err.message}`, to: recipients }
  }
}

export async function verifyMailer() {
  const tx = getTransporter()
  if (!tx) return { ok: false, error: '邮件功能已禁用' }
  try {
    await tx.verify()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}
