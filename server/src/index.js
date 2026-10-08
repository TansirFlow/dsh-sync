/**
 * DSH Sync 服务主入口。
 *
 * 对外提供四类能力：
 *   1. POST /api/ingest        —— DSH 插件推送会话事件（共享密钥鉴权）
 *   2. /api/auth/*             —— 注册 / 登录 / 登出（多用户）
 *   3. /api/sessions*          —— 登录用户查看自己的会话（强制归属校验）
 *   4. GET  /s/<token>         —— 邮件里的免登录分享链接
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname, isAbsolute } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'

import { config, assertConfig } from './config.js'
import {
  json, html, text, redirect, readJson, readBody, parseCookies,
  signValue, unsignValue, randomToken, safeEqual, rateLimit, clientIp,
} from './http.js'
import * as store from './db.js'
import { sendSessionNotification, verifyMailer } from './mailer.js'
import { projectTranscript, buildPreview, eventTypeHistogram } from './transcript.js'
import {
  renderLoginPage, renderDashboard, renderSessionPage, renderSharedPage, renderErrorPage,
  renderNotifySettings, renderChat, renderAdmin,
} from './views.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(__dirname, '..', 'public')

const COOKIE_NAME = 'dsh_sync_session'
const COOKIE_MAX_AGE = 7 * 86400

/* ------------------------------------------------------------ 静态资源 */

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

async function serveStatic(res, pathname) {
  const rel = pathname.replace(/^\/static\//, '')
  if (rel.includes('..')) return text(res, 400, 'bad path')
  try {
    const buf = await readFile(join(PUBLIC_DIR, rel))
    res.writeHead(200, {
      'Content-Type': MIME[extname(rel)] ?? 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=3600',
    })
    res.end(buf)
    return true
  } catch {
    return false
  }
}

/* ---------------------------------------------------------------- 鉴权 */

function currentUser(req) {
  const raw = parseCookies(req)[COOKIE_NAME]
  if (!raw) return null
  const userId = unsignValue(raw, config.shareSecret)
  if (!userId) return null
  const user = store.getUserById(userId)
  if (!user) return null
  return user
}

function setSessionCookie(res, userId) {
  const signed = signValue(userId, config.shareSecret)
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(signed)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`,
  )
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

/** 需要登录的 API：未登录直接 401。 */
function requireUser(req, res) {
  const user = currentUser(req)
  if (!user) {
    json(res, 401, { error: '未登录', code: 'UNAUTHENTICATED' })
    return null
  }
  return user
}

/** 需要管理员权限。非管理员一律 404，不暴露后台是否存在。 */
function requireAdmin(req, res) {
  const user = currentUser(req)
  if (!user) {
    json(res, 401, { error: '未登录', code: 'UNAUTHENTICATED' })
    return null
  }
  if (!user.is_admin) {
    store.audit({ userId: user.id, actorEmail: user.email, action: 'admin.denied', detail: req.url, ip: clientIp(req) })
    json(res, 404, { error: '页面不存在' })
    return null
  }
  return user
}

/** 把任务行整理成前端要的形状（去掉内部字段，长文本按需附带）。 */
function publicTask(t, withBody = false) {
  if (!t) return null
  const base = {
    id: t.id,
    prompt: t.prompt,
    cwd: t.cwd,
    status: t.status,
    sessionId: t.session_id,
    attempts: t.attempts,
    createdAt: t.created_at,
    startedAt: t.started_at,
    finishedAt: t.finished_at,
  }
  if (withBody) {
    base.resultText = t.result_text
    base.error = t.error
    base.exitCode = t.exit_code
    base.ownerEmail = t.owner_email
    base.winner = t.winner
  }
  return base
}

/* ------------------------------------------------------------ 业务逻辑 */

function shareUrlFor(token) {
  return `${config.publicBaseUrl.replace(/\/$/, '')}/s/${token}`
}

/** 组装一个会话的完整展示数据。 */
function buildSessionView(session, owner) {
  const events = store.getEvents(session.id)
  const transcript = projectTranscript(events)
  return {
    session: {
      ...session,
      ownerEmail: owner?.email ?? null,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
    },
    transcript,
    histogram: eventTypeHistogram(events),
    eventCount: events.length,
  }
}

/**
 * 处理一次插件推送：写库；若是这个会话的第一条新会话，则建分享链接并发邮件。
 */
async function handleIngest(payload, actorIp = null) {
  const result = store.upsertSession({
    id: payload.sessionId,
    ownerEmail: payload.ownerEmail,
    title: payload.title,
    cwd: payload.cwd,
    agentPreset: payload.agentPreset,
    model: payload.model,
    createdAt: payload.createdAt,
    events: payload.events ?? [],
  })

  const session = store.getSessionAny(result.sessionId)
  const owner = store.getUserById(session.owner_id)

  // 首次落库即视为"新对话开启"：建链接 + 发邮件（只发一次）
  if (result.isNew && !session.notified_at && config.mailEnabled) {
    const { token } = store.createShareLink(session.id)
    const events = store.getEvents(session.id)
    const transcript = projectTranscript(events)
    const preview = buildPreview(transcript)

    const to = resolveRecipients({ owner, explicit: payload.notifyTo })
    if (to.length) {
      const mail = await sendSessionNotification({
        to,
        session: { ...session, ownerEmail: owner?.email },
        shareUrl: shareUrlFor(token),
        preview,
      })
      // 每个收件人单独记一行，便于排查是谁没收到
      for (const addr of mail.to) {
        store.markNotified(session.id, addr, mail.ok, mail.error ?? null)
      }
      store.audit({
        userId: owner?.id ?? null,
        actorEmail: owner?.email ?? null,
        action: 'notify.new_session',
        detail: `${session.id} -> ${mail.to.join(', ')}${mail.ok ? '' : ` (失败: ${mail.error})`}`,
        ip: actorIp,
      })
      return { ...result, notified: mail.ok, notifyTo: mail.to, notifyError: mail.error ?? null, shareUrl: shareUrlFor(token) }
    }
    store.markNotified(session.id, '(no-recipient)', false, '没有可用的收件人')
    return { ...result, notified: false, notifyError: '没有可用的收件人' }
  }

  return { ...result, notified: false }
}

/**
 * 决定这封通知发给谁。优先级：
 *   1. 推送里显式指定的 notifyTo
 *   2. 该用户在「通知邮箱」页配置的启用地址
 *   3. 用户注册邮箱本身
 *   4. 全局兜底 DSH_SYNC_NOTIFY_TO
 */
function resolveRecipients({ owner, explicit }) {
  const out = []
  const push = (v) => {
    if (!v) return
    for (const addr of Array.isArray(v) ? v : [v]) {
      const s = String(addr).trim()
      if (s && !out.includes(s)) out.push(s)
    }
  }
  push(explicit)
  if (out.length === 0 && owner) push(store.enabledNotifyEmails(owner.id))
  if (out.length === 0) push(owner?.email)
  if (out.length === 0) push(config.defaultNotifyTo)
  return out
}

/* -------------------------------------------------------------- 路由 */

async function route(req, res, url) {
  const { pathname } = url
  const method = req.method ?? 'GET'

  /* ---------- 静态资源 ---------- */
  if (pathname.startsWith('/static/')) {
    if (await serveStatic(res, pathname)) return
    return text(res, 404, 'not found')
  }

  /* ---------- 健康检查 ---------- */
  if (pathname === '/healthz') {
    return json(res, 200, { ok: true, time: Date.now() })
  }

  /* ---------- 插件推送 ---------- */
  if (pathname === '/api/ingest' && method === 'POST') {
    const auth = req.headers.authorization ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (!config.ingestToken || !safeEqual(token, config.ingestToken)) {
      return json(res, 401, { error: '推送密钥无效' })
    }
    const limit = rateLimit(`ingest:${clientIp(req)}`, 600, 60_000)
    if (!limit.ok) return json(res, 429, { error: '请求过于频繁' })

    let payload
    try {
      payload = await readJson(req)
    } catch (err) {
      return json(res, 400, { error: err.message })
    }
    if (!payload?.sessionId || !payload?.ownerEmail) {
      return json(res, 400, { error: '缺少 sessionId 或 ownerEmail' })
    }
    try {
      const result = await handleIngest(payload)
      return json(res, 200, { ok: true, ...result })
    } catch (err) {
      if (err.code === 'OWNER_NOT_FOUND') return json(res, 404, { error: err.message, code: err.code })
      console.error('[ingest] 失败:', err)
      return json(res, 500, { error: err.message })
    }
  }

  /* ---------- 注册 ---------- */
  if (pathname === '/api/auth/register' && method === 'POST') {
    const limit = rateLimit(`reg:${clientIp(req)}`, 10, 3600_000)
    if (!limit.ok) return json(res, 429, { error: '注册过于频繁，请稍后再试' })
    let body
    try {
      body = await readJson(req, 64 * 1024)
    } catch (err) {
      return json(res, 400, { error: err.message })
    }
    const { email, password, displayName } = body
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return json(res, 400, { error: '邮箱格式不正确' })
    }
    if (!password || String(password).length < 6) {
      return json(res, 400, { error: '密码至少 6 位' })
    }
    try {
      const user = store.createUser({ email, password, displayName, isAdmin: store.countUsers() === 0 })
      setSessionCookie(res, user.id)
      return json(res, 200, { ok: true, user: { id: user.id, email: user.email } })
    } catch (err) {
      if (err.code === 'DUPLICATE_EMAIL') return json(res, 409, { error: err.message })
      throw err
    }
  }

  /* ---------- 登录 ---------- */
  if (pathname === '/api/auth/login' && method === 'POST') {
    const limit = rateLimit(`login:${clientIp(req)}`, 20, 300_000)
    if (!limit.ok) return json(res, 429, { error: '尝试过于频繁，请稍后再试' })
    let body
    try {
      body = await readJson(req, 64 * 1024)
    } catch (err) {
      return json(res, 400, { error: err.message })
    }
    const user = store.getUserByEmail(body.email ?? '')
    if (!user || !store.verifyPassword(body.password ?? '', user.salt, user.password_hash)) {
      return json(res, 401, { error: '邮箱或密码错误' })
    }
    setSessionCookie(res, user.id)
    return json(res, 200, { ok: true, user: { id: user.id, email: user.email } })
  }

  /* ---------- 登出 ---------- */
  if (pathname === '/api/auth/logout' && method === 'POST') {
    clearSessionCookie(res)
    return json(res, 200, { ok: true })
  }

  if (pathname === '/api/auth/me') {
    const user = currentUser(req)
    if (!user) return json(res, 401, { error: '未登录' })
    return json(res, 200, {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        isAdmin: Boolean(user.is_admin),
      },
      stats: store.statsForUser(user.id),
    })
  }

  /* ---------- 我的会话列表 ---------- */
  if (pathname === '/api/sessions' && method === 'GET') {
    const user = requireUser(req, res)
    if (!user) return
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 500)
    const offset = Math.max(Number(url.searchParams.get('offset') ?? 0), 0)
    const search = url.searchParams.get('q') ?? ''
    return json(res, 200, {
      sessions: store.listSessionsForUser(user.id, { limit, offset, search }),
      total: store.countSessionsForUser(user.id, search),
    })
  }

  /* ---------- 单条会话（本人） ---------- */
  const mine = pathname.match(/^\/api\/sessions\/([^/]+)$/)
  if (mine && method === 'GET') {
    const user = requireUser(req, res)
    if (!user) return
    const session = store.getSessionForUser(decodeURIComponent(mine[1]), user.id)
    if (!session) return json(res, 404, { error: '会话不存在或无权访问' })
    return json(res, 200, buildSessionView(session, user))
  }

  /* ---------- 重新发送通知邮件 ---------- */
  const resend = pathname.match(/^\/api\/sessions\/([^/]+)\/notify$/)
  if (resend && method === 'POST') {
    const user = requireUser(req, res)
    if (!user) return
    const session = store.getSessionForUser(decodeURIComponent(resend[1]), user.id)
    if (!session) return json(res, 404, { error: '会话不存在或无权访问' })

    let token = session.share_token
    if (!token) token = store.createShareLink(session.id).token
    const events = store.getEvents(session.id)
    const transcript = projectTranscript(events)
    const mail = await sendSessionNotification({
      to: user.email,
      session: { ...session, ownerEmail: user.email },
      shareUrl: shareUrlFor(token),
      preview: buildPreview(transcript),
    })
    store.markNotified(session.id, user.email, mail.ok, mail.error ?? null)
    return json(res, mail.ok ? 200 : 502, { ok: mail.ok, error: mail.error, shareUrl: shareUrlFor(token) })
  }

  /* ---------- 撤销分享链接 ---------- */
  const revoke = pathname.match(/^\/api\/sessions\/([^/]+)\/revoke$/)
  if (revoke && method === 'POST') {
    const user = requireUser(req, res)
    if (!user) return
    const session = store.getSessionForUser(decodeURIComponent(revoke[1]), user.id)
    if (!session) return json(res, 404, { error: '会话不存在或无权访问' })
    if (session.share_token) store.revokeShareLink(session.share_token)
    return json(res, 200, { ok: true })
  }

  /* ---------- 原始事件（本人） ---------- */
  const raw = pathname.match(/^\/api\/sessions\/([^/]+)\/events$/)
  if (raw && method === 'GET') {
    const user = requireUser(req, res)
    if (!user) return
    const session = store.getSessionForUser(decodeURIComponent(raw[1]), user.id)
    if (!session) return json(res, 404, { error: '会话不存在或无权访问' })
    return json(res, 200, { events: store.getEvents(session.id) })
  }

  /* ================= 通知邮箱设置 ================= */

  if (pathname === '/api/notify-emails' && method === 'GET') {
    const user = requireUser(req, res)
    if (!user) return
    return json(res, 200, { emails: store.listNotifyEmails(user.id), fallback: user.email })
  }

  if (pathname === '/api/notify-emails' && method === 'POST') {
    const user = requireUser(req, res)
    if (!user) return
    let body
    try {
      body = await readJson(req, 16 * 1024)
    } catch (err) {
      return json(res, 400, { error: err.message })
    }
    try {
      const added = store.addNotifyEmail(user.id, body.email, body.label ?? null)
      store.audit({ userId: user.id, actorEmail: user.email, action: 'notify.add', detail: added.email, ip: clientIp(req) })
      return json(res, 200, { ok: true, email: added })
    } catch (err) {
      if (err.code === 'DUPLICATE_EMAIL') return json(res, 409, { error: err.message })
      if (err.code === 'BAD_EMAIL') return json(res, 400, { error: err.message })
      throw err
    }
  }

  const notifyItem = pathname.match(/^\/api\/notify-emails\/(\d+)$/)
  if (notifyItem && method === 'PATCH') {
    const user = requireUser(req, res)
    if (!user) return
    let body
    try {
      body = await readJson(req, 16 * 1024)
    } catch (err) {
      return json(res, 400, { error: err.message })
    }
    const ok = store.updateNotifyEmail(user.id, Number(notifyItem[1]), {
      label: body.label,
      enabled: body.enabled,
    })
    if (!ok) return json(res, 404, { error: '记录不存在' })
    store.audit({ userId: user.id, actorEmail: user.email, action: 'notify.update', detail: `#${notifyItem[1]}`, ip: clientIp(req) })
    return json(res, 200, { ok: true })
  }

  if (notifyItem && method === 'DELETE') {
    const user = requireUser(req, res)
    if (!user) return
    const n = store.removeNotifyEmail(user.id, Number(notifyItem[1]))
    if (!n) return json(res, 404, { error: '记录不存在' })
    store.audit({ userId: user.id, actorEmail: user.email, action: 'notify.remove', detail: `#${notifyItem[1]}`, ip: clientIp(req) })
    return json(res, 200, { ok: true })
  }

  /* ================= 网页端发起对话（队列模式） =================
   * 云端不执行任务，只入队；本地的 worker 进程主动拉取并跑 headless。
   */

  if (pathname === '/api/chat/options' && method === 'GET') {
    const user = requireUser(req, res)
    if (!user) return
    const workers = store.listWorkers().filter((w) => !w.revoked)
    const online = workers.filter((w) => w.last_seen_at && Date.now() - w.last_seen_at < 90_000)
    return json(res, 200, {
      enabled: config.task.enabled,
      timeoutMs: config.task.timeoutMs,
      maxPromptChars: config.task.maxPromptChars,
      maxPerUser: config.task.maxPerUser,
      workers: workers.length,
      workersOnline: online.length,
    })
  }

  if (pathname === '/api/chat/tasks' && method === 'POST') {
    const user = requireUser(req, res)
    if (!user) return
    if (!config.task.enabled) return json(res, 403, { error: '网页端发起对话已被禁用' })
    const limit = rateLimit(`chat:${user.id}`, 30, 600_000)
    if (!limit.ok) return json(res, 429, { error: '提交过于频繁，请稍后再试' })

    // 没有在线执行节点就直接拒绝，避免任务永远排队
    const online = store
      .listWorkers()
      .filter((w) => !w.revoked && w.last_seen_at && Date.now() - w.last_seen_at < 90_000)
    if (online.length === 0) {
      return json(res, 503, { error: '当前没有在线的执行节点（本地 worker 未运行）', code: 'NO_WORKER' })
    }

    let body
    try {
      body = await readJson(req, config.task.maxPromptChars + 4096)
    } catch (err) {
      return json(res, 400, { error: err.message })
    }

    const text = String(body.prompt ?? '').trim()
    if (!text) return json(res, 400, { error: '对话内容不能为空', code: 'EMPTY_PROMPT' })
    if (text.length > config.task.maxPromptChars) {
      return json(res, 400, { error: `对话内容过长（上限 ${config.task.maxPromptChars} 字）`, code: 'PROMPT_TOO_LONG' })
    }
    if (store.countRunningTasks(user.id) >= config.task.maxPerUser) {
      return json(res, 429, { error: `你已有 ${config.task.maxPerUser} 个任务未完成，请稍等`, code: 'TOO_MANY_TASKS' })
    }

    // 云端先做一层浅校验，尽早挡掉明显非法的路径；
    // 真正决定性的校验在 worker 侧 —— 只有它知道本机的允许根目录。
    const cwd = body.cwd == null || String(body.cwd).trim() === '' ? null : String(body.cwd).trim()
    if (cwd !== null && !isAbsolute(cwd)) {
      return json(res, 400, { error: '工作目录必须是绝对路径', code: 'BAD_CWD' })
    }

    const id = randomUUID()
    const task = store.createTask({ id, userId: user.id, prompt: text, cwd })
    store.audit({ userId: user.id, actorEmail: user.email, action: 'chat.submit', detail: `${id}: ${text.slice(0, 80)}`, ip: clientIp(req) })
    return json(res, 200, { ok: true, task: publicTask(task) })
  }

  if (pathname === '/api/chat/tasks' && method === 'GET') {
    const user = requireUser(req, res)
    if (!user) return
    return json(res, 200, { tasks: store.listTasksForUser(user.id, 50).map((t) => publicTask(t, true)) })
  }

  const taskItem = pathname.match(/^\/api\/chat\/tasks\/([0-9a-fA-F-]{36})$/)
  if (taskItem && method === 'GET') {
    const user = requireUser(req, res)
    if (!user) return
    const task = store.getTaskForUser(taskItem[1], user.id)
    if (!task) return json(res, 404, { error: '任务不存在或无权访问' })
    return json(res, 200, { task: publicTask(task, true) })
  }

  const taskCancel = pathname.match(/^\/api\/chat\/tasks\/([0-9a-fA-F-]{36})\/cancel$/)
  if (taskCancel && method === 'POST') {
    const user = requireUser(req, res)
    if (!user) return
    const task = store.getTaskForUser(taskCancel[1], user.id)
    if (!task) return json(res, 404, { error: '任务不存在或无权访问' })
    const n = store.cancelTaskRow(task.id)
    store.audit({ userId: user.id, actorEmail: user.email, action: 'chat.cancel', detail: task.id, ip: clientIp(req) })
    return json(res, 200, { ok: true, cancelled: n > 0 })
  }

  /* ================= Worker（本地执行节点）接口 ================= */

  if (pathname.startsWith('/api/worker/')) {
    const auth = req.headers.authorization ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (!token) return json(res, 401, { error: '缺少 worker token' })

    const tokenHash = createHash('sha256').update(token).digest('hex')
    const worker = store.findWorkerByTokenHash(tokenHash)
    if (!worker) return json(res, 401, { error: 'worker token 无效或已撤销' })

    const workerId = worker.id

    if (pathname === '/api/worker/tasks/next' && method === 'POST') {
      let body = {}
      try {
        body = await readJson(req, 8192)
      } catch {
        /* 用默认值 */
      }
      store.touchWorker(workerId, clientIp(req), body.version ?? null)
      const leaseMs = Math.min(Number(body.leaseSeconds ?? 120), 3600) * 1000
      const task = store.leaseNextTask(workerId, leaseMs)
      if (!task) return json(res, 200, { task: null })
      const owner = store.getUserById(task.user_id)
      return json(res, 200, {
        task: {
          id: task.id,
          prompt: task.prompt,
          cwd: task.cwd,
          ownerEmail: owner?.email ?? null,
          attempts: task.attempts,
        },
      })
    }

    const renew = pathname.match(/^\/api\/worker\/tasks\/([0-9a-fA-F-]{36})\/renew$/)
    if (renew && method === 'POST') {
      let body = {}
      try {
        body = await readJson(req, 8192)
      } catch {
        /* 默认 */
      }
      store.touchWorker(workerId, clientIp(req), null)
      const leaseMs = Math.min(Number(body.leaseSeconds ?? 120), 3600) * 1000
      const n = store.renewLease(renew[1], workerId, leaseMs)
      return json(res, 200, { ok: n > 0 })
    }

    const complete = pathname.match(/^\/api\/worker\/tasks\/([0-9a-fA-F-]{36})\/complete$/)
    if (complete && method === 'POST') {
      let body
      try {
        body = await readJson(req, 4 * 1024 * 1024)
      } catch (err) {
        return json(res, 400, { error: err.message })
      }
      const allowed = new Set(['succeeded', 'failed', 'timeout', 'cancelled'])
      const status = allowed.has(body.status) ? body.status : 'failed'
      const n = store.completeTask(complete[1], workerId, {
        status,
        exitCode: body.exitCode,
        resultText: body.resultText,
        logText: body.logText,
        sessionId: body.sessionId,
        error: body.error,
      })
      if (n === 0) return json(res, 409, { error: '任务状态已变化（可能已被回收）' })
      store.touchWorker(workerId, clientIp(req), null)
      store.audit({ userId: null, actorEmail: null, action: 'worker.complete', detail: `${complete[1]} -> ${status}`, ip: clientIp(req) })
      return json(res, 200, { ok: true })
    }

    if (pathname === '/api/worker/heartbeat' && method === 'POST') {
      let body = {}
      try {
        body = await readJson(req, 8192)
      } catch {
        /* 默认 */
      }
      store.touchWorker(workerId, clientIp(req), body.version ?? null)
      return json(res, 200, { ok: true, workerId })
    }

    return json(res, 404, { error: '未知的 worker 接口' })
  }

  /* ================= 管理员后台 ================= */

  if (pathname === '/api/admin/stats' && method === 'GET') {
    const user = requireAdmin(req, res)
    if (!user) return
    return json(res, 200, { stats: store.globalStats(), workers: store.listWorkers() })
  }

  if (pathname === '/api/admin/users' && method === 'GET') {
    const user = requireAdmin(req, res)
    if (!user) return
    return json(res, 200, { users: store.listAllUsers() })
  }

  const adminUser = pathname.match(/^\/api\/admin\/users\/([0-9a-f-]+)$/)
  if (adminUser && method === 'PATCH') {
    const admin = requireAdmin(req, res)
    if (!admin) return
    let body
    try {
      body = await readJson(req, 16 * 1024)
    } catch (err) {
      return json(res, 400, { error: err.message })
    }
    if (adminUser[1] === admin.id && body.isAdmin === false) {
      return json(res, 400, { error: '不能取消自己的管理员权限' })
    }
    const n = store.setUserAdmin(adminUser[1], Boolean(body.isAdmin))
    if (!n) return json(res, 404, { error: '用户不存在' })
    store.audit({ userId: admin.id, actorEmail: admin.email, action: 'admin.set_admin', detail: `${adminUser[1]} -> ${body.isAdmin}`, ip: clientIp(req) })
    return json(res, 200, { ok: true })
  }

  if (pathname === '/api/admin/sessions' && method === 'GET') {
    const user = requireAdmin(req, res)
    if (!user) return
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 500)
    return json(res, 200, { sessions: store.listAllSessions({ limit, search: url.searchParams.get('q') ?? '' }) })
  }

  if (pathname === '/api/admin/mail' && method === 'GET') {
    const user = requireAdmin(req, res)
    if (!user) return
    return json(res, 200, { mails: store.listMailLog(200) })
  }

  if (pathname === '/api/admin/tasks' && method === 'GET') {
    const user = requireAdmin(req, res)
    if (!user) return
    return json(res, 200, { tasks: store.listAllTasks(100).map((t) => publicTask(t, true)) })
  }

  if (pathname === '/api/admin/audit' && method === 'GET') {
    const user = requireAdmin(req, res)
    if (!user) return
    return json(res, 200, { audit: store.listAudit(200) })
  }

  /** 管理员可以查看任意用户的会话内容。 */
  const adminSession = pathname.match(/^\/api\/admin\/sessions\/([^/]+)$/)
  if (adminSession && method === 'GET') {
    const user = requireAdmin(req, res)
    if (!user) return
    const session = store.getSessionAny(decodeURIComponent(adminSession[1]))
    if (!session) return json(res, 404, { error: '会话不存在' })
    const owner = store.getUserById(session.owner_id)
    store.audit({ userId: user.id, actorEmail: user.email, action: 'admin.view_session', detail: session.id, ip: clientIp(req) })
    return json(res, 200, buildSessionView(session, owner))
  }

  /* ---------- 分享链接（免登录） ---------- */
  const share = pathname.match(/^\/api\/share\/(.+)$/)
  if (share && method === 'GET') {
    const resolved = store.resolveShareLink(decodeURIComponent(share[1]))
    if (!resolved || resolved.error) {
      return json(res, 404, { error: resolved?.error ?? '链接无效' })
    }
    return json(res, 200, buildSessionView(resolved.session, resolved.owner))
  }

  /* ---------- 分享页（HTML） ---------- */
  const sharePage = pathname.match(/^\/s\/(.+)$/)
  if (sharePage && method === 'GET') {
    const token = decodeURIComponent(sharePage[1])
    const resolved = store.resolveShareLink(token)
    if (!resolved || resolved.error) {
      return html(res, 404, renderErrorPage(resolved?.error ?? '链接无效'))
    }
    const view = buildSessionView(resolved.session, resolved.owner)
    return html(res, 200, renderSharedPage(view, token))
  }

  /* ---------- 页面 ---------- */
  if (pathname === '/login' || pathname === '/register') {
    const user = currentUser(req)
    if (user) return redirect(res, '/')
    return html(res, 200, renderLoginPage(pathname === '/register'))
  }

  if (pathname === '/') {
    const user = currentUser(req)
    if (!user) return redirect(res, '/login')
    return html(res, 200, renderDashboard(user, store.listSessionsForUser(user.id, { limit: 200 }), store.statsForUser(user.id)))
  }

  /* ---------- 通知邮箱设置页 ---------- */
  if (pathname === '/settings/notify') {
    const user = currentUser(req)
    if (!user) return redirect(res, '/login')
    return html(res, 200, renderNotifySettings(user, store.listNotifyEmails(user.id)))
  }

  /* ---------- 发起对话页 ---------- */
  if (pathname === '/chat') {
    const user = currentUser(req)
    if (!user) return redirect(res, '/login')
    const workers = store.listWorkers().filter((w) => !w.revoked)
    const online = workers.filter((w) => w.last_seen_at && Date.now() - w.last_seen_at < 90_000)
    return html(res, 200, renderChat(user, {
      enabled: config.task.enabled,
      timeoutMs: config.task.timeoutMs,
      maxPromptChars: config.task.maxPromptChars,
      maxPerUser: config.task.maxPerUser,
      workers: workers.length,
      workersOnline: online.length,
    }))
  }

  /* ---------- 管理后台 ---------- */
  if (pathname === '/admin') {
    const user = currentUser(req)
    if (!user) return redirect(res, '/login')
    if (!user.is_admin) return html(res, 404, renderErrorPage('页面不存在'))
    return html(res, 200, renderAdmin(user, store.globalStats(), store.listWorkers()))
  }

  const adminDetail = pathname.match(/^\/admin\/session\/([^/]+)$/)
  if (adminDetail) {
    const user = currentUser(req)
    if (!user) return redirect(res, '/login')
    if (!user.is_admin) return html(res, 404, renderErrorPage('页面不存在'))
    const session = store.getSessionAny(decodeURIComponent(adminDetail[1]))
    if (!session) return html(res, 404, renderErrorPage('会话不存在'))
    const owner = store.getUserById(session.owner_id)
    return html(res, 200, renderSessionPage(buildSessionView(session, owner), user, { adminView: true }))
  }

  const detail = pathname.match(/^\/sessions\/([^/]+)$/)
  if (detail && method === 'GET') {
    const user = currentUser(req)
    if (!user) return redirect(res, '/login')
    const session = store.getSessionForUser(decodeURIComponent(detail[1]), user.id)
    if (!session) return html(res, 404, renderErrorPage('会话不存在或无权访问'))
    return html(res, 200, renderSessionPage(buildSessionView(session, user), user))
  }

  return html(res, 404, renderErrorPage('页面不存在'))
}

/* -------------------------------------------------------------- 启动 */

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  route(req, res, url).catch((err) => {
    console.error('[server] 未捕获错误:', err)
    if (!res.headersSent) json(res, 500, { error: '服务器内部错误' })
    else res.end()
  })
})

const problems = assertConfig()
for (const p of problems) console.warn(`[config] 警告: ${p}`)

// 服务重启后，之前被 worker 领走但没回报的任务不应该永远卡在 leased：
// 放回队列，让在线的 worker 重新领取。
const released = store.releaseAllLeases()
if (released > 0) console.log(`[dsh-sync] 启动时释放了 ${released} 个未完成的租约，已重新入队`)

// 租约回收定时器：worker 崩溃时任务会被自动重排，超过重试上限则判失败。
const reaper = setInterval(() => {
  try {
    const { requeued, failed } = store.reapExpiredLeases(3)
    if (requeued || failed) {
      console.log(`[dsh-sync] 租约回收：重排 ${requeued}，判定失败 ${failed}`)
    }
  } catch (err) {
    console.error('[dsh-sync] 租约回收出错:', err.message)
  }
}, 30_000)
reaper.unref?.()

server.listen(config.port, config.host, async () => {
  console.log(`[dsh-sync] 监听 http://${config.host}:${config.port}`)
  console.log(`[dsh-sync] 对外地址 ${config.publicBaseUrl}`)
  console.log(`[dsh-sync] 数据库 ${config.dbPath}`)
  const workers = store.listWorkers().filter((w) => !w.revoked)
  console.log(`[dsh-sync] 已注册执行节点 ${workers.length} 个`)
  if (config.mailEnabled) {
    const v = await verifyMailer()
    console.log(`[dsh-sync] SMTP ${v.ok ? '连接正常' : `异常: ${v.error}`}`)
  } else {
    console.log('[dsh-sync] 邮件通知已禁用')
  }
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n[dsh-sync] 收到 ${sig}，正在关闭`)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000)
  })
}
