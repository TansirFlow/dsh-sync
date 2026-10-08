/**
 * 服务端渲染的页面。字面量 HTML，不引模板引擎。
 * 所有用户内容一律经过 escapeHtml，避免 XSS。
 */

import { config } from './config.js'

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function fmtTime(ms) {
  if (!ms) return '-'
  return new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}

function fmtSize(n) {
  if (!n) return '-'
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

const BASE_CSS = `
:root{--bg:#f6f7f9;--fg:#111827;--muted:#6b7280;--line:#e5e7eb;--card:#fff;--accent:#1f6feb;--accent-soft:#eef4ff;--user:#1f6feb;--asst:#059669;--warn:#b45309;--err:#dc2626;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;font-size:15px;line-height:1.65}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:1040px;margin:0 auto;padding:0 20px}
header.top{background:#fff;border-bottom:1px solid var(--line);position:sticky;top:0;z-index:10}
header.top .wrap{display:flex;align-items:center;justify-content:space-between;height:60px}
.brand{font-weight:700;font-size:16px;display:flex;align-items:center;gap:9px}
.brand .dot{width:9px;height:9px;border-radius:50%;background:var(--accent)}
.brand small{font-weight:400;color:var(--muted);font-size:12px;margin-left:6px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px;margin-bottom:16px}
.stat-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px}
.stat{background:#fff;border:1px solid var(--line);border-radius:10px;padding:16px}
.stat .n{font-size:24px;font-weight:700;line-height:1.2}
.stat .l{font-size:12px;color:var(--muted);margin-top:2px}
.sess{display:block;padding:15px 0;border-bottom:1px solid var(--line);color:inherit}
.sess:last-child{border-bottom:0}
.sess:hover{text-decoration:none;background:#fafbfc;margin:0 -12px;padding-left:12px;padding-right:12px;border-radius:8px}
.sess .t{font-weight:600;margin-bottom:3px}
.sess .m{font-size:12.5px;color:var(--muted);display:flex;gap:14px;flex-wrap:wrap}
.msg{margin-bottom:22px}
.msg .who{font-size:12px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;margin-bottom:7px;display:flex;align-items:center;gap:8px}
.msg .who .t{color:var(--muted);font-weight:400;text-transform:none;letter-spacing:0}
.msg.user .who{color:var(--user)}
.msg.assistant .who{color:var(--asst)}
.bubble{border-radius:10px;padding:14px 17px;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere}
.msg.user .bubble{background:var(--accent-soft);border:1px solid #d8e4ff}
.msg.assistant .bubble{background:#fff;border:1px solid var(--line)}
.bubble code{background:#f3f4f6;padding:1px 5px;border-radius:4px;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.bubble pre{background:#0f172a;color:#e2e8f0;padding:12px 14px;border-radius:8px;overflow-x:auto;font-size:13px;white-space:pre;margin:10px 0}
.bubble pre code{background:none;color:inherit;padding:0}
.tool{background:#fbfbfc;border:1px solid var(--line);border-left:3px solid #9ca3af;border-radius:8px;padding:10px 14px;margin:12px 0;font-size:13.5px}
.tool .hd{font-weight:600;color:#374151;display:flex;justify-content:space-between;gap:10px;align-items:center}
.tool .out{margin-top:8px;color:#4b5563;white-space:pre-wrap;max-height:340px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;background:#fff;border:1px solid var(--line);border-radius:6px;padding:9px}
.tool.err{border-left-color:var(--err)}
.badge{display:inline-block;font-size:11px;padding:1px 8px;border-radius:20px;background:#f3f4f6;color:#4b5563;font-weight:600}
.badge.ok{background:#dcfce7;color:#166534}
.badge.no{background:#fee2e2;color:#991b1b}
.empty{text-align:center;color:var(--muted);padding:48px 20px}
.btn{display:inline-block;background:var(--accent);color:#fff;border:0;padding:9px 18px;border-radius:7px;font-size:14px;font-weight:600;cursor:pointer}
.btn:hover{text-decoration:none;opacity:.92}
.btn.sec{background:#fff;color:var(--fg);border:1px solid var(--line)}
.btn.sm{padding:5px 12px;font-size:12.5px}
input[type=email],input[type=password],input[type=text]{width:100%;padding:10px 13px;border:1px solid var(--line);border-radius:7px;font-size:14px;font-family:inherit}
label{display:block;font-size:13px;font-weight:600;margin:14px 0 5px}
.auth{max-width:410px;margin:70px auto}
.err-box{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;padding:10px 14px;border-radius:7px;font-size:13.5px;margin-top:14px}
details{margin-top:14px}
summary{cursor:pointer;font-size:13.5px;color:var(--muted);font-weight:600}
table.hist{width:100%;border-collapse:collapse;font-size:13px;margin-top:10px}
table.hist td{padding:5px 8px;border-bottom:1px solid var(--line)}
table.hist td:last-child{text-align:right;color:var(--muted)}
footer{text-align:center;color:var(--muted);font-size:12px;padding:26px 0}
.turn-sep{text-align:center;color:#9ca3af;font-size:11.5px;margin:26px 0 18px;letter-spacing:.08em}
.turn-sep::before,.turn-sep::after{content:'—';margin:0 10px;color:#e5e7eb}
.note{background:#fffbeb;border:1px solid #fde68a;color:#92400e;padding:9px 14px;border-radius:7px;font-size:12.5px;margin-bottom:16px}
.nav{display:flex;align-items:center;gap:18px;font-size:14px}
.nav a{color:var(--muted);font-weight:500}
.nav a:hover{color:var(--accent);text-decoration:none}
.nav .who{color:var(--muted);font-size:12.5px;border-left:1px solid var(--line);padding-left:14px}
@media(max-width:720px){.nav{gap:10px;font-size:13px}.nav .who{display:none}.nav a{padding:2px 0}}
textarea{width:100%;padding:11px 13px;border:1px solid var(--line);border-radius:7px;font-size:14px;font-family:inherit;resize:vertical;min-height:96px}
select{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:7px;font-size:14px;font-family:inherit;background:#fff}
.btn.danger{background:#dc2626}
.btn:disabled{opacity:.5;cursor:not-allowed}
.pill{display:inline-block;font-size:11.5px;padding:2px 9px;border-radius:20px;font-weight:600}
.pill.queued{background:#fef3c7;color:#92400e}
.pill.leased{background:#dbeafe;color:#1e40af}
.pill.succeeded{background:#dcfce7;color:#166534}
.pill.failed,.pill.timeout{background:#fee2e2;color:#991b1b}
.pill.cancelled{background:#f3f4f6;color:#4b5563}
table.grid{width:100%;border-collapse:collapse;font-size:13.5px}
table.grid th{text-align:left;padding:9px 10px;border-bottom:2px solid var(--line);font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
table.grid td{padding:10px;border-bottom:1px solid var(--line);vertical-align:top}
table.grid tr:last-child td{border-bottom:0}
.tabs{display:flex;gap:6px;margin-bottom:18px;border-bottom:1px solid var(--line);overflow-x:auto}
.tabs button{background:none;border:0;padding:10px 15px;font-size:14px;font-family:inherit;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap}
.tabs button.active{color:var(--accent);border-bottom-color:var(--accent);font-weight:600}
.tabpane{display:none}
.tabpane.active{display:block}
.answer{background:#f9fafb;border:1px solid var(--line);border-radius:9px;padding:15px 17px;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere;font-size:14.5px}
.answer code{background:#eef0f3;padding:1px 5px;border-radius:4px;font-size:13px;font-family:ui-monospace,monospace}
.spin{display:inline-block;width:13px;height:13px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:sp .7s linear infinite;vertical-align:-2px}
@keyframes sp{to{transform:rotate(360deg)}}
`

function layout(title, bodyHtml, { bare = false, user = null } = {}) {
  const nav = user
    ? `<nav class="nav">
        <a href="/">我的会话</a>
        <a href="/chat">发起对话</a>
        <a href="/settings/notify">通知邮箱</a>
        ${user.is_admin ? '<a href="/admin">管理后台</a>' : ''}
        <span class="who">${escapeHtml(user.email)}</span>
        <button class="btn sec sm" id="nav-logout">退出</button>
      </nav>`
    : ''
  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
<style>${BASE_CSS}</style>
</head><body>
${bare ? '' : `
<header class="top"><div class="wrap">
  <a href="/" class="brand"><span class="dot"></span>DSH Sync<small>会话记录</small></a>
  ${nav}
</div></header>`}
${bodyHtml}
<footer>DSH Sync · ${escapeHtml(config.publicBaseUrl)}</footer>
<script>
document.getElementById('nav-logout')?.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.href = '/login';
});
</script>
</body></html>`
}

/* --------------------------------------------------------------- 登录 */

export function renderLoginPage(isRegister = false) {
  const action = isRegister ? '注册' : '登录'
  return layout(`${action} · DSH Sync`, `
<div class="wrap auth">
  <div class="card">
    <h2 style="margin:0 0 4px;font-size:20px;">${action} DSH Sync</h2>
    <p style="color:var(--muted);font-size:13.5px;margin:0 0 8px;">
      ${isRegister ? '注册后,你在 DSH 上开启的对话会自动同步到这里。' : '登录后查看你自己的所有对话记录。'}
    </p>
    <form id="f">
      <label for="email">邮箱</label>
      <input type="email" id="email" required autocomplete="username" placeholder="you@example.com">
      <label for="password">密码</label>
      <input type="password" id="password" required autocomplete="${isRegister ? 'new-password' : 'current-password'}" placeholder="${isRegister ? '至少 6 位' : ''}">
      <div id="msg"></div>
      <button class="btn" type="submit" style="width:100%;margin-top:18px;">${action}</button>
    </form>
    <p style="text-align:center;font-size:13.5px;color:var(--muted);margin:18px 0 0;">
      ${isRegister ? '已有账号?<a href="/login">去登录</a>' : '还没有账号?<a href="/register">去注册</a>'}
    </p>
  </div>
</div>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('msg');
  msg.innerHTML = '';
  try {
    const r = await fetch('/api/auth/${isRegister ? 'register' : 'login'}', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.getElementById('email').value,
        password: document.getElementById('password').value,
      }),
    });
    const j = await r.json();
    if (j.ok) { location.href = '/'; return; }
    msg.innerHTML = '<div class="err-box">' + (j.error || '操作失败') + '</div>';
  } catch (err) {
    msg.innerHTML = '<div class="err-box">网络错误:' + err.message + '</div>';
  }
});
</script>`)
}

/* ------------------------------------------------------------- 控制台 */

export function renderDashboard(user, sessions, stats) {
  const rows = sessions.length
    ? sessions.map((s) => `
      <a class="sess" href="/sessions/${encodeURIComponent(s.id)}">
        <div class="t">${escapeHtml(s.title || '未命名会话')}</div>
        <div class="m">
          <span>${escapeHtml(fmtTime(s.updated_at))}</span>
          <span>${escapeHtml(s.cwd || '-')}</span>
          <span>${s.turn_count} 轮 · ${fmtSize(s.event_count)} 事件</span>
          ${s.notified_at ? '<span class="badge ok">已邮件通知</span>' : '<span class="badge">未通知</span>'}
        </div>
      </a>`).join('')
    : `<div class="empty">还没有同步过来的对话。<br><span style="font-size:13px;">在 DSH 里开启一个新对话,记录会自动出现在这里。</span></div>`

  return layout('我的会话 · DSH Sync', `
<div class="wrap" style="padding-top:24px;">
  <div class="stat-row">
    <div class="stat"><div class="n">${stats.sessions}</div><div class="l">会话总数</div></div>
    <div class="stat"><div class="n">${stats.turns}</div><div class="l">对话轮次</div></div>
    <div class="stat"><div class="n">${fmtSize(stats.events)}</div><div class="l">事件总数</div></div>
    <div class="stat"><div class="n" style="font-size:15px;padding-top:6px;">${escapeHtml(fmtTime(stats.last))}</div><div class="l">最近活动</div></div>
  </div>
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
      <h3 style="margin:0;font-size:16px;">我的对话记录</h3>
      <div style="display:flex;gap:8px;align-items:center;">
        <input type="text" id="q" placeholder="搜索标题或目录…" style="width:200px;padding:6px 11px;">
        <button class="btn sec sm" id="logout">退出</button>
      </div>
    </div>
    <div id="list" style="margin-top:10px;">${rows}</div>
  </div>
</div>
<script>
document.getElementById('logout').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.href = '/login';
});
let timer = null;
document.getElementById('q').addEventListener('input', (e) => {
  clearTimeout(timer);
  const q = e.target.value.trim();
  timer = setTimeout(async () => {
    const r = await fetch('/api/sessions?q=' + encodeURIComponent(q));
    const j = await r.json();
    const list = document.getElementById('list');
    if (!j.sessions || !j.sessions.length) {
      list.innerHTML = '<div class="empty">没有匹配的会话</div>';
      return;
    }
    list.innerHTML = j.sessions.map((s) => \`
      <a class="sess" href="/sessions/\${encodeURIComponent(s.id)}">
        <div class="t">\${escapeHtml(s.title || '未命名会话')}</div>
        <div class="m">
          <span>\${new Date(s.updated_at).toLocaleString('zh-CN')}</span>
          <span>\${escapeHtml(s.cwd || '-')}</span>
          <span>\${s.turn_count} 轮 · \${s.event_count} 事件</span>
        </div>
      </a>\`).join('');
  }, 250);
});
function escapeHtml(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
</script>`, { user })
}

/* --------------------------------------------------------- 记录渲染 */

/** 把纯文本渲染成带代码块的 HTML。 */
function renderRichText(text) {
  if (!text) return ''
  const parts = String(text).split(/```/)
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      // 代码块
      const body = part.replace(/^[a-zA-Z0-9_+-]*\n/, '')
      return `<pre><code>${escapeHtml(body.replace(/\n$/, ''))}</code></pre>`
    }
    // 普通文本：行内 code 单独处理
    return part
      .split(/(`[^`\n]+`)/)
      .map((seg) =>
        seg.startsWith('`') && seg.endsWith('`') && seg.length > 2
          ? `<code>${escapeHtml(seg.slice(1, -1))}</code>`
          : escapeHtml(seg),
      )
      .join('')
  }).join('')
}

function shortArgs(args) {
  if (args == null) return ''
  try {
    const s = typeof args === 'string' ? args : JSON.stringify(args)
    return s.length > 160 ? `${s.slice(0, 160)}…` : s
  } catch {
    return ''
  }
}

function renderMessages(transcript) {
  const out = []
  for (const m of transcript.messages) {
    if (m.kind === 'user') {
      out.push(`
      <div class="msg user">
        <div class="who">用户 <span class="t">${escapeHtml(fmtTime(m.time))}</span></div>
        <div class="bubble">${renderRichText(m.text)}</div>
      </div>`)
    } else if (m.kind === 'assistant') {
      const calls = (m.toolCalls ?? []).map((c) => `
        <div class="tool">
          <div class="hd"><span>调用工具 · ${escapeHtml(c.name)}</span></div>
          ${c.args != null ? `<div class="out">${escapeHtml(shortArgs(c.args))}</div>` : ''}
        </div>`).join('')
      out.push(`
      <div class="msg assistant">
        <div class="who">助手 <span class="t">${escapeHtml(fmtTime(m.time))}${m.turn ? ` · 第 ${m.turn} 轮` : ''}</span></div>
        ${m.text.trim() ? `<div class="bubble">${renderRichText(m.text)}</div>` : ''}
        ${calls}
      </div>`)
    } else if (m.kind === 'tool_result') {
      out.push(`
      <div class="tool${m.isError ? ' err' : ''}">
        <div class="hd">
          <span>工具结果 · ${escapeHtml(m.name)}</span>
          ${m.isError ? '<span class="badge no">失败</span>' : '<span class="badge ok">成功</span>'}
        </div>
        ${m.text ? `<div class="out">${escapeHtml(m.text.length > 4000 ? `${m.text.slice(0, 4000)}\n…（已截断）` : m.text)}</div>` : ''}
      </div>`)
    } else if (m.kind === 'turn_end') {
      out.push(`<div class="turn-sep">第 ${m.turn ?? '?'} 轮结束${m.reason ? ` · ${escapeHtml(m.reason)}` : ''}</div>`)
    }
  }
  return out.join('')
}

function renderHistogram(histogram) {
  if (!histogram?.length) return ''
  return `<table class="hist">${histogram.map((h) => `<tr><td>${escapeHtml(h.type)}</td><td>${h.count}</td></tr>`).join('')}</table>`
}

/* --------------------------------------------------------- 分享页面 */

export function renderSharedPage(view, token) {
  const { session, transcript, histogram } = view
  const body = transcript.messages.length
    ? renderMessages(transcript)
    : '<div class="empty">这个会话还没有可展示的内容。</div>'

  return layout(session.title || '共享会话', `
<div class="wrap" style="padding-top:24px;">
  <div class="note">你正在通过邮件中的分享链接查看这条对话记录,无需登录。请勿将链接转发给他人。</div>
  <div class="card">
    <h1 style="margin:0 0 8px;font-size:21px;line-height:1.35;">${escapeHtml(session.title || '未命名会话')}</h1>
    <div class="m" style="font-size:13px;color:var(--muted);display:flex;gap:16px;flex-wrap:wrap;">
      <span>归属:${escapeHtml(session.ownerEmail || '-')}</span>
      <span>开始:${escapeHtml(fmtTime(session.created_at))}</span>
      <span>目录:${escapeHtml(session.cwd || '-')}</span>
      <span>${transcript.stats.turns} 轮 · ${transcript.stats.userMessages} 条提问 · ${transcript.stats.toolCalls} 次工具调用</span>
    </div>
  </div>
  <div class="card">${body}</div>
  <div class="card">
    <details>
      <summary>会话统计</summary>
      ${renderHistogram(histogram)}
    </details>
  </div>
</div>`, { bare: false })
}

/* --------------------------------------------------------- 详情页面 */

export function renderSessionPage(view, user, { adminView = false } = {}) {
  const { session, transcript, histogram } = view
  const body = transcript.messages.length
    ? renderMessages(transcript)
    : '<div class="empty">这个会话还没有可展示的内容。</div>'
  const shareLink = session.share_token
    ? `${config.publicBaseUrl.replace(/\/$/, '')}/s/${session.share_token}`
    : null

  const backHref = adminView ? '/admin' : '/'
  const backText = adminView ? '← 返回管理后台' : '← 返回列表'
  const adminNote = adminView
    ? `<div class="note">管理员视角：该会话归属 <b>${escapeHtml(session.owner_email || session.ownerEmail || '-')}</b></div>`
    : ''
  return layout(session.title || '会话详情', `
<div class="wrap" style="padding-top:24px;">
  <div style="margin-bottom:14px;"><a href="${backHref}">${backText}</a></div>
  ${adminNote}
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap;">
      <h1 style="margin:0;font-size:21px;line-height:1.35;">${escapeHtml(session.title || '未命名会话')}</h1>
      <div style="display:flex;gap:8px;">
        <button class="btn sec sm" id="notify">重发通知邮件</button>
        ${shareLink ? '<button class="btn sec sm" id="revoke">撤销分享链接</button>' : ''}
      </div>
    </div>
    <div style="font-size:13px;color:var(--muted);display:flex;gap:16px;flex-wrap:wrap;margin-top:8px;">
      <span>开始:${escapeHtml(fmtTime(session.created_at))}</span>
      <span>更新:${escapeHtml(fmtTime(session.updated_at))}</span>
      <span>目录:${escapeHtml(session.cwd || '-')}</span>
      <span>${transcript.stats.turns} 轮 · ${transcript.stats.toolCalls} 次工具调用</span>
      ${session.notified_at ? '<span class="badge ok">已邮件通知</span>' : '<span class="badge">未通知</span>'}
    </div>
    ${shareLink ? `
    <div style="margin-top:14px;">
      <label style="margin-top:0;">分享链接</label>
      <input type="text" readonly value="${escapeHtml(shareLink)}" onclick="this.select()" style="font-size:12.5px;font-family:ui-monospace,monospace;">
    </div>` : ''}
    <div id="action-msg"></div>
  </div>
  <div class="card">${body}</div>
  <div class="card">
    <details>
      <summary>会话统计（${view.eventCount} 个事件）</summary>
      ${renderHistogram(histogram)}
    </details>
  </div>
</div>
<script>
const SID = ${JSON.stringify(session.id)};
document.getElementById('notify')?.addEventListener('click', async (e) => {
  e.target.disabled = true; e.target.textContent = '发送中…';
  const r = await fetch('/api/sessions/' + encodeURIComponent(SID) + '/notify', { method: 'POST' });
  const j = await r.json();
  document.getElementById('action-msg').innerHTML = j.ok
    ? '<div class="note" style="background:#dcfce7;border-color:#bbf7d0;color:#166534;">邮件已发送到 ${escapeHtml(user.email)}</div>'
    : '<div class="err-box">发送失败:' + (j.error || '未知错误') + '</div>';
  e.target.disabled = false; e.target.textContent = '重发通知邮件';
});
document.getElementById('revoke')?.addEventListener('click', async () => {
  if (!confirm('确定撤销这个分享链接?撤销后邮件里的链接将失效。')) return;
  await fetch('/api/sessions/' + encodeURIComponent(SID) + '/revoke', { method: 'POST' });
  location.reload();
});
</script>`, { user })
}

/* --------------------------------------------------------- 错误页面 */

export function renderErrorPage(message) {
  return layout('出错了 · DSH Sync', `
<div class="wrap auth">
  <div class="card" style="text-align:center;">
    <h2 style="margin:0 0 8px;font-size:20px;">无法打开</h2>
    <p style="color:var(--muted);font-size:14px;">${escapeHtml(message)}</p>
    <a class="btn" href="/" style="margin-top:14px;">回到首页</a>
  </div>
</div>`)
}

/* --------------------------------------------------- 通知邮箱设置页 */

export function renderNotifySettings(user, emails) {
  const rows = emails.length
    ? emails.map((e) => `
      <tr data-id="${e.id}">
        <td>
          <div style="font-weight:600;">${escapeHtml(e.email)}</div>
          ${e.label ? `<div style="font-size:12px;color:var(--muted);">${escapeHtml(e.label)}</div>` : ''}
        </td>
        <td style="text-align:right;white-space:nowrap;">
          <label style="display:inline-flex;align-items:center;gap:6px;font-weight:400;margin:0;cursor:pointer;">
            <input type="checkbox" class="toggle" ${e.enabled ? 'checked' : ''}> 启用
          </label>
          <button class="btn sec sm rm" style="margin-left:10px;">删除</button>
        </td>
      </tr>`).join('')
    : `<tr><td colspan="2" style="color:var(--muted);padding:20px 10px;">还没有配置额外的通知邮箱。</td></tr>`

  return layout('通知邮箱 · DSH Sync', `
<div class="wrap" style="padding-top:24px;">
  <h1 style="margin:0 0 6px;font-size:20px;">通知邮箱</h1>
  <p style="color:var(--muted);font-size:13.5px;margin:0 0 20px;">
    每当一个<b>新对话</b>开启，系统会向下面<b>所有已启用</b>的邮箱，以及你的注册邮箱发送带免登录链接的通知。
  </p>

  <div class="card">
    <h3 style="margin:0 0 10px;font-size:15px;">已配置的收件地址</h3>
    <table class="grid"><tbody id="list">${rows}</tbody></table>
  </div>

  <div class="card">
    <h3 style="margin:0 0 12px;font-size:15px;">添加收件地址</h3>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
      <div style="flex:1;min-width:200px;">
        <label for="ne">邮箱地址</label>
        <input type="email" id="ne" placeholder="someone@example.com">
      </div>
      <div style="flex:1;min-width:160px;">
        <label for="nl">备注（可选）</label>
        <input type="text" id="nl" placeholder="例如：团队群组">
      </div>
      <button class="btn" id="add" style="margin-bottom:1px;">添加</button>
    </div>
    <div id="msg"></div>
  </div>

  <div class="card" style="background:#f9fafb;">
    <div style="font-size:13.5px;color:var(--muted);line-height:1.9;">
      <b style="color:var(--fg);">说明</b><br>
      · 你的注册邮箱 <code>${escapeHtml(user.email)}</code> 始终会收到通知，无需在此添加。<br>
      · 关闭「启用」开关后，该邮箱仍保留在列表里，但不再收信。<br>
      · 同一个邮箱不会重复添加。
    </div>
  </div>
</div>
<script>
const msg = document.getElementById('msg');
function show(text, ok) {
  msg.innerHTML = '<div class="' + (ok ? 'note' : 'err-box') + '" style="' + (ok ? 'background:#dcfce7;border-color:#bbf7d0;color:#166534;' : '') + '">' + text + '</div>';
}
document.getElementById('add').addEventListener('click', async () => {
  const email = document.getElementById('ne').value.trim();
  const label = document.getElementById('nl').value.trim();
  if (!email) return show('请填写邮箱地址', false);
  const r = await fetch('/api/notify-emails', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, label }),
  });
  const j = await r.json();
  if (j.ok) location.reload();
  else show(j.error || '添加失败', false);
});
document.getElementById('list').addEventListener('click', async (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const id = tr.dataset.id;
  if (e.target.classList.contains('rm')) {
    if (!confirm('确定删除这个通知邮箱？')) return;
    await fetch('/api/notify-emails/' + id, { method: 'DELETE' });
    location.reload();
  }
});
document.getElementById('list').addEventListener('change', async (e) => {
  if (!e.target.classList.contains('toggle')) return;
  const tr = e.target.closest('tr[data-id]');
  await fetch('/api/notify-emails/' + tr.dataset.id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: e.target.checked }),
  });
});
</script>`, { user })
}

/* ------------------------------------------------------- 发起对话页 */

export function renderChat(user, options) {
  const noWorker = options.workersOnline === 0
  return layout('发起对话 · DSH Sync', `
<div class="wrap" style="padding-top:24px;">
  <h1 style="margin:0 0 6px;font-size:20px;">发起对话</h1>
  <p style="color:var(--muted);font-size:13.5px;margin:0 0 20px;">
    任务会进入云端队列，由你本地机器上的 worker 领取并执行 DSH。执行期间可以离开本页，稍后回来查看。
  </p>

  <div id="worker-warn" class="${noWorker ? '' : 'hidden'}">
    <div class="err-box" style="margin-bottom:16px;">
      <b>当前没有在线的执行节点。</b><br>
      请在本地 DSH 机器上启动 worker 进程后再提交任务。否则任务会一直排队。
    </div>
  </div>

  <div class="card">
    <label for="p">要交给 DSH 的任务</label>
    <textarea id="p" placeholder="例如：统计当前目录下各类型文件的数量并按大小排序"></textarea>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;gap:12px;flex-wrap:wrap;">
      <div style="font-size:12.5px;color:var(--muted);">
        上限 ${options.maxPromptChars} 字 · 超时 ${Math.round(options.timeoutMs / 1000)} 秒
        · 在线节点 <b id="wn">${options.workersOnline}</b>/${options.workers}
      </div>
      <button class="btn" id="submit">提交任务</button>
    </div>
    <div id="msg"></div>
  </div>

  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <h3 style="margin:0;font-size:15px;">我的任务</h3>
      <button class="btn sec sm" id="refresh">刷新</button>
    </div>
    <div id="tasks" style="margin-top:12px;"><div class="empty">加载中…</div></div>
  </div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const STATUS_TEXT = { queued:'排队中', leased:'执行中', succeeded:'已完成', failed:'失败', timeout:'超时', cancelled:'已取消' };
function fmt(ms){ return ms ? new Date(ms).toLocaleString('zh-CN',{hour12:false}) : '-'; }

async function loadTasks() {
  const r = await fetch('/api/chat/tasks');
  const j = await r.json();
  const box = $('tasks');
  if (!j.tasks || !j.tasks.length) { box.innerHTML = '<div class="empty">还没有任务</div>'; return; }
  box.innerHTML = j.tasks.map(t => {
    const running = t.status === 'queued' || t.status === 'leased';
    return '<div class="card" style="margin-bottom:12px;padding:15px;">'
      + '<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;">'
      + '<div style="flex:1;min-width:220px;font-weight:600;">' + esc(t.prompt.slice(0,200)) + (t.prompt.length>200?'…':'') + '</div>'
      + '<span class="pill ' + t.status + '">' + (STATUS_TEXT[t.status]||t.status) + (running?' <span class="spin"></span>':'') + '</span>'
      + '</div>'
      + '<div style="font-size:12px;color:var(--muted);margin-top:7px;">提交 ' + fmt(t.createdAt) + (t.finishedAt?' · 结束 '+fmt(t.finishedAt):'') + '</div>'
      + (t.resultText ? '<div class="answer" style="margin-top:11px;">' + esc(t.resultText.slice(0,4000)) + '</div>' : '')
      + (t.error ? '<div class="err-box" style="margin-top:11px;">' + esc(t.error.slice(0,600)) + '</div>' : '')
      + (t.sessionId ? '<div style="margin-top:10px;font-size:13px;"><a href="/sessions/' + encodeURIComponent(t.sessionId) + '">查看完整会话记录 →</a></div>' : '')
      + (running ? '<div style="margin-top:10px;"><button class="btn sec sm cancel" data-id="' + t.id + '">取消</button></div>' : '')
      + '</div>';
  }).join('');
}

$('submit').addEventListener('click', async () => {
  const prompt = $('p').value.trim();
  if (!prompt) { $('msg').innerHTML = '<div class="err-box">请填写任务内容</div>'; return; }
  $('submit').disabled = true; $('submit').textContent = '提交中…';
  try {
    const r = await fetch('/api/chat/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const j = await r.json();
    if (j.ok) { $('p').value = ''; $('msg').innerHTML = '<div class="note" style="background:#dcfce7;border-color:#bbf7d0;color:#166534;">已提交，等待本地 worker 领取</div>'; loadTasks(); }
    else $('msg').innerHTML = '<div class="err-box">' + esc(j.error || '提交失败') + '</div>';
  } catch (e) { $('msg').innerHTML = '<div class="err-box">网络错误：' + esc(e.message) + '</div>'; }
  $('submit').disabled = false; $('submit').textContent = '提交任务';
});

$('tasks').addEventListener('click', async (e) => {
  if (!e.target.classList.contains('cancel')) return;
  if (!confirm('确定取消这个任务？')) return;
  await fetch('/api/chat/tasks/' + e.target.dataset.id + '/cancel', { method: 'POST' });
  loadTasks();
});

$('refresh').addEventListener('click', loadTasks);
loadTasks();
setInterval(loadTasks, 5000);
</script>`, { user })
}

/* --------------------------------------------------------- 管理后台 */

export function renderAdmin(user, stats, workers) {
  const workerRows = workers.length
    ? workers.map((w) => {
        const alive = w.last_seen_at && Date.now() - w.last_seen_at < 90_000
        return `<tr>
          <td><b>${escapeHtml(w.name)}</b><div style="font-size:12px;color:var(--muted);">${escapeHtml(w.id)}</div></td>
          <td>${alive ? '<span class="pill succeeded">在线</span>' : '<span class="pill cancelled">离线</span>'}</td>
          <td style="font-size:12.5px;color:var(--muted);">${w.last_seen_at ? escapeHtml(fmtTime(w.last_seen_at)) : '从未'}<br>${escapeHtml(w.last_ip || '-')}</td>
          <td>${escapeHtml(w.version || '-')}</td>
          <td style="text-align:right;"><button class="btn sec sm rw" data-id="${escapeHtml(w.id)}">撤销</button></td>
        </tr>`
      }).join('')
    : `<tr><td colspan="5" style="color:var(--muted);padding:20px 10px;">还没有注册的执行节点。</td></tr>`

  return layout('管理后台 · DSH Sync', `
<div class="wrap" style="padding-top:24px;">
  <h1 style="margin:0 0 18px;font-size:20px;">管理后台</h1>

  <div class="stat-row">
    <div class="stat"><div class="n" id="s-users">${stats.users}</div><div class="l">用户</div></div>
    <div class="stat"><div class="n">${stats.sessions}</div><div class="l">会话</div></div>
    <div class="stat"><div class="n">${stats.events}</div><div class="l">事件</div></div>
    <div class="stat"><div class="n">${stats.tasks}</div><div class="l">任务（${stats.queued} 排队 / ${stats.running} 执行中）</div></div>
    <div class="stat"><div class="n">${stats.mails_ok}</div><div class="l">邮件成功（失败 ${stats.mails_fail}）</div></div>
  </div>

  <div class="tabs">
    <button class="active" data-tab="t-users">用户</button>
    <button data-tab="t-sessions">全部会话</button>
    <button data-tab="t-workers">执行节点</button>
    <button data-tab="t-tasks">任务</button>
    <button data-tab="t-mail">邮件日志</button>
    <button data-tab="t-audit">审计日志</button>
  </div>

  <div class="card">
    <div class="tabpane active" id="t-users">
      <table class="grid"><thead><tr><th>邮箱</th><th>注册时间</th><th>会话数</th><th>通知邮箱</th><th style="text-align:right;">管理员</th></tr></thead>
      <tbody id="users-body"><tr><td colspan="5">加载中…</td></tr></tbody></table>
    </div>

    <div class="tabpane" id="t-sessions">
      <input type="text" id="sq" placeholder="搜索标题 / 目录 / 所属邮箱…" style="margin-bottom:12px;">
      <table class="grid"><thead><tr><th>标题</th><th>归属</th><th>更新时间</th><th>规模</th></tr></thead>
      <tbody id="sessions-body"><tr><td colspan="4">加载中…</td></tr></tbody></table>
    </div>

    <div class="tabpane" id="t-workers">
      <table class="grid"><thead><tr><th>节点</th><th>状态</th><th>最后心跳</th><th>版本</th><th></th></tr></thead>
      <tbody>${workerRows}</tbody></table>
    </div>

    <div class="tabpane" id="t-tasks">
      <table class="grid"><thead><tr><th>任务</th><th>归属</th><th>状态</th><th>时间</th></tr></thead>
      <tbody id="tasks-body"><tr><td colspan="4">加载中…</td></tr></tbody></table>
    </div>

    <div class="tabpane" id="t-mail">
      <table class="grid"><thead><tr><th>会话</th><th>收件人</th><th>结果</th><th>时间</th></tr></thead>
      <tbody id="mail-body"><tr><td colspan="4">加载中…</td></tr></tbody></table>
    </div>

    <div class="tabpane" id="t-audit">
      <table class="grid"><thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>详情</th></tr></thead>
      <tbody id="audit-body"><tr><td colspan="4">加载中…</td></tr></tbody></table>
    </div>
  </div>
</div>
<script>
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = (ms) => ms ? new Date(ms).toLocaleString('zh-CN',{hour12:false}) : '-';
const STATUS = { queued:'排队中', leased:'执行中', succeeded:'已完成', failed:'失败', timeout:'超时', cancelled:'已取消' };
const loaded = {};

document.querySelector('.tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.tabpane').forEach(p => p.classList.toggle('active', p.id === btn.dataset.tab));
  loadTab(btn.dataset.tab);
});

async function loadTab(tab) {
  if (loaded[tab]) return;
  loaded[tab] = true;
  if (tab === 't-users') await loadUsers();
  if (tab === 't-sessions') await loadSessions();
  if (tab === 't-tasks') await loadTasks();
  if (tab === 't-mail') await loadMail();
  if (tab === 't-audit') await loadAudit();
}

async function loadUsers() {
  const j = await (await fetch('/api/admin/users')).json();
  document.getElementById('users-body').innerHTML = (j.users||[]).map(u =>
    '<tr><td><b>' + esc(u.email) + '</b>' + (u.display_name ? '<div style="font-size:12px;color:var(--muted);">' + esc(u.display_name) + '</div>' : '') + '</td>'
    + '<td style="font-size:12.5px;color:var(--muted);">' + fmt(u.created_at) + '</td>'
    + '<td>' + u.session_count + '</td><td>' + u.notify_count + '</td>'
    + '<td style="text-align:right;"><label style="display:inline-flex;gap:6px;align-items:center;font-weight:400;margin:0;cursor:pointer;">'
    + '<input type="checkbox" class="adm" data-id="' + u.id + '"' + (u.is_admin?' checked':'') + '> 管理员</label></td></tr>'
  ).join('') || '<tr><td colspan="5">无</td></tr>';
}

async function loadSessions() {
  const q = document.getElementById('sq').value.trim();
  const j = await (await fetch('/api/admin/sessions?q=' + encodeURIComponent(q))).json();
  document.getElementById('sessions-body').innerHTML = (j.sessions||[]).map(s =>
    '<tr><td><a href="/admin/session/' + encodeURIComponent(s.id) + '">' + esc(s.title || '未命名') + '</a>'
    + '<div style="font-size:12px;color:var(--muted);">' + esc(s.cwd || '-') + '</div></td>'
    + '<td style="font-size:12.5px;">' + esc(s.owner_email) + '</td>'
    + '<td style="font-size:12.5px;color:var(--muted);">' + fmt(s.updated_at) + '</td>'
    + '<td style="font-size:12.5px;">' + s.turn_count + ' 轮 · ' + s.event_count + ' 事件</td></tr>'
  ).join('') || '<tr><td colspan="4">无</td></tr>';
}

async function loadTasks() {
  const j = await (await fetch('/api/admin/tasks')).json();
  document.getElementById('tasks-body').innerHTML = (j.tasks||[]).map(t =>
    '<tr><td>' + esc(String(t.prompt).slice(0,90)) + '</td>'
    + '<td style="font-size:12.5px;">' + esc(t.ownerEmail||'-') + '</td>'
    + '<td><span class="pill ' + t.status + '">' + (STATUS[t.status]||t.status) + '</span></td>'
    + '<td style="font-size:12.5px;color:var(--muted);">' + fmt(t.createdAt) + '</td></tr>'
  ).join('') || '<tr><td colspan="4">无</td></tr>';
}

async function loadMail() {
  const j = await (await fetch('/api/admin/mail')).json();
  document.getElementById('mail-body').innerHTML = (j.mails||[]).map(m =>
    '<tr><td>' + esc(m.title || m.session_id) + '</td><td style="font-size:12.5px;">' + esc(m["to"]) + '</td>'
    + '<td>' + (m.ok ? '<span class="pill succeeded">成功</span>' : '<span class="pill failed">失败</span>'
        + (m.error ? '<div style="font-size:11.5px;color:#991b1b;margin-top:3px;">' + esc(String(m.error).slice(0,120)) + '</div>' : '')) + '</td>'
    + '<td style="font-size:12.5px;color:var(--muted);">' + fmt(m.sent_at) + '</td></tr>'
  ).join('') || '<tr><td colspan="4">无</td></tr>';
}

async function loadAudit() {
  const j = await (await fetch('/api/admin/audit')).json();
  document.getElementById('audit-body').innerHTML = (j.audit||[]).map(a =>
    '<tr><td style="font-size:12.5px;color:var(--muted);">' + fmt(a.time) + '</td>'
    + '<td style="font-size:12.5px;">' + esc(a.actor_email || '-') + '</td>'
    + '<td style="font-size:12.5px;"><b>' + esc(a.action) + '</b></td>'
    + '<td style="font-size:12px;color:var(--muted);word-break:break-all;">' + esc(String(a.detail||'').slice(0,160)) + '</td></tr>'
  ).join('') || '<tr><td colspan="4">无</td></tr>';
}

document.getElementById('users-body').addEventListener('change', async (e) => {
  if (!e.target.classList.contains('adm')) return;
  const r = await fetch('/api/admin/users/' + e.target.dataset.id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isAdmin: e.target.checked }),
  });
  const j = await r.json();
  if (!j.ok) { alert(j.error || '操作失败'); e.target.checked = !e.target.checked; }
});

document.querySelector('#t-workers').addEventListener('click', async (e) => {
  if (!e.target.classList.contains('rw')) return;
  if (!confirm('撤销这个执行节点？撤销后它将无法再领取任务。')) return;
  await fetch('/api/admin/workers/' + encodeURIComponent(e.target.dataset.id), { method: 'DELETE' });
  location.reload();
});

let sqTimer;
document.getElementById('sq').addEventListener('input', () => {
  clearTimeout(sqTimer);
  sqTimer = setTimeout(() => { loaded['t-sessions'] = false; loadSessions().then(()=>loaded['t-sessions']=true); }, 300);
});

loadUsers();
</script>`, { user })
}
