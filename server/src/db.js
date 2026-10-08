/**
 * SQLite 存储层。
 *
 * 多用户隔离的核心：每个 session 行带 owner_id，所有读取路径都强制按 owner 过滤。
 * 分享 token 单独一张表，携带 session_id 与明文可见范围，用于邮件里的免登录链接。
 */

import Database from 'better-sqlite3'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from './config.js'

mkdirSync(dirname(config.dbPath), { recursive: true })

export const db = new Database(config.dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  display_name  TEXT,
  created_at    INTEGER NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,          -- DSH session id，形如 session-<uuid>
  owner_id      TEXT NOT NULL,
  title         TEXT,
  cwd           TEXT,
  agent_preset  TEXT,
  model         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  event_count   INTEGER NOT NULL DEFAULT 0,
  turn_count    INTEGER NOT NULL DEFAULT 0,
  share_token   TEXT,
  notified_at   INTEGER,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  type          TEXT NOT NULL,
  time          INTEGER,
  data          TEXT NOT NULL,             -- 原始 event JSON
  UNIQUE(session_id, seq),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);

CREATE TABLE IF NOT EXISTS share_links (
  token       TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER,
  revoked     INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mail_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  "to"        TEXT NOT NULL,
  sent_at     INTEGER NOT NULL,
  ok          INTEGER NOT NULL,
  error       TEXT
);

-- 每个用户可配置多个通知邮箱；新会话开启时按这些地址群发。
CREATE TABLE IF NOT EXISTS notify_emails (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  email       TEXT NOT NULL,
  label       TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  UNIQUE(user_id, email),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_notify_user ON notify_emails(user_id);

-- 入站 Webhook 密钥：允许外部系统（如 CI、其他 agent）触发一次对话。
CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  key_hash    TEXT NOT NULL,
  prefix      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked     INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 网页端发起的对话任务。
-- 注意：云端**不执行**任务，只入队；由本地的 worker 进程主动拉取并执行 headless。
CREATE TABLE IF NOT EXISTS chat_tasks (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  prompt       TEXT NOT NULL,
  cwd          TEXT,
  status       TEXT NOT NULL,          -- queued | leased | succeeded | failed | timeout | cancelled
  session_id   TEXT,                   -- 执行完回报的 DSH 会话 id
  winner       TEXT,                   -- 领取任务的 worker 标识
  lease_until  INTEGER,                -- 租约到期时间，超时未回报则回收重排
  attempts     INTEGER NOT NULL DEFAULT 0,
  exit_code    INTEGER,
  result_text  TEXT,                   -- worker 回报的最终回答
  log_text     TEXT,                   -- 原始输出（截断）
  error        TEXT,
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  finished_at  INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON chat_tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON chat_tasks(status, created_at ASC);

-- 注册的 worker（本地执行节点）。用 token 鉴权。
CREATE TABLE IF NOT EXISTS workers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  last_seen_at  INTEGER,
  last_ip       TEXT,
  version       TEXT,
  created_at    INTEGER NOT NULL,
  revoked       INTEGER NOT NULL DEFAULT 0
);

-- 审计日志：登录、越权尝试、管理员操作等。
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT,
  actor_email TEXT,
  action      TEXT NOT NULL,
  detail      TEXT,
  ip          TEXT,
  time        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(time DESC);
`)

/* ---------------------------------------------------------------- 密码 */

const SCRYPT_KEYLEN = 64

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = createHash('sha256').update(salt + password).digest('hex')
  return { hash, salt }
}

/** 简化但恒定时间的比较，避免长度差异泄露信息。 */
export function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt)
  const a = Buffer.from(hash, 'hex')
  const b = Buffer.from(expectedHash, 'hex')
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/* ---------------------------------------------------------------- 用户 */

export function createUser({ email, password, displayName = null, isAdmin = false }) {
  const normalized = String(email).trim().toLowerCase()
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalized)
  if (existing) {
    const err = new Error('该邮箱已注册')
    err.code = 'DUPLICATE_EMAIL'
    throw err
  }
  const { hash, salt } = hashPassword(password)
  const id = randomUUID()
  db.prepare(
    `INSERT INTO users (id, email, password_hash, salt, display_name, created_at, is_admin)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, normalized, hash, salt, displayName, Date.now(), isAdmin ? 1 : 0)
  return getUserById(id)
}

export function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim().toLowerCase())
}

export function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id)
}

export function countUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n
}

/* ----------------------------------------------------------- 会话写入 */

/**
 * 写入/更新一个会话及其事件。按 (session_id, seq) 幂等，重复推送不会产生重复记录。
 * 返回 { sessionId, inserted, total }。
 */
export const upsertSession = db.transaction((payload) => {
  const now = Date.now()
  const {
    id,
    ownerEmail,
    title = null,
    cwd = null,
    agentPreset = null,
    model = null,
    createdAt = now,
  } = payload

  const owner = ownerEmail ? getUserByEmail(ownerEmail) : null
  if (!owner) {
    const err = new Error(`会话 ${id} 的归属邮箱 ${ownerEmail} 不存在`)
    err.code = 'OWNER_NOT_FOUND'
    throw err
  }

  const existing = db.prepare('SELECT id, created_at, notified_at FROM sessions WHERE id = ?').get(id)
  if (!existing) {
    db.prepare(
      `INSERT INTO sessions (id, owner_id, title, cwd, agent_preset, model, created_at, updated_at, event_count, turn_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
    ).run(id, owner.id, title, cwd, agentPreset, model, createdAt, now)
  } else {
    db.prepare(
      `UPDATE sessions SET
         title = COALESCE(?, title),
         cwd = COALESCE(?, cwd),
         agent_preset = COALESCE(?, agent_preset),
         model = COALESCE(?, model),
         updated_at = ?
       WHERE id = ?`,
    ).run(title, cwd, agentPreset, model, now, id)
  }

  const insertEvent = db.prepare(
    `INSERT OR IGNORE INTO events (session_id, seq, type, time, data) VALUES (?, ?, ?, ?, ?)`,
  )
  let inserted = 0
  for (const ev of payload.events ?? []) {
    const info = insertEvent.run(id, ev.seq, ev.type, ev.time ?? null, JSON.stringify(ev))
    inserted += info.changes
  }

  const stats = db
    .prepare(
      `SELECT COUNT(*) AS n,
              SUM(CASE WHEN type = 'turn/start' THEN 1 ELSE 0 END) AS turns,
              MAX(COALESCE(time, 0)) AS lastTime
       FROM events WHERE session_id = ?`,
    )
    .get(id)

  db.prepare(
    `UPDATE sessions SET event_count = ?, turn_count = COALESCE(?, 0), updated_at = ? WHERE id = ?`,
  ).run(stats.n, stats.turns, now, id)

  return { sessionId: id, inserted, total: stats.n, isNew: !existing, ownerId: owner.id }
})

export function markNotified(sessionId, to, ok, error = null) {
  db.prepare(
    `INSERT INTO mail_log (session_id, "to", sent_at, ok, error) VALUES (?, ?, ?, ?, ?)`,
  ).run(sessionId, to, Date.now(), ok ? 1 : 0, error)
  if (ok) {
    db.prepare('UPDATE sessions SET notified_at = ? WHERE id = ?').run(Date.now(), sessionId)
  }
}

/* ----------------------------------------------------------- 会话读取 */

export function listSessionsForUser(ownerId, { limit = 100, offset = 0, search = '' } = {}) {
  const like = `%${search}%`
  return db
    .prepare(
      `SELECT s.id, s.title, s.cwd, s.created_at, s.updated_at, s.event_count, s.turn_count,
              s.share_token, s.notified_at
       FROM sessions s
       WHERE s.owner_id = ? AND (? = '' OR s.title LIKE ? OR s.cwd LIKE ?)
       ORDER BY s.updated_at DESC LIMIT ? OFFSET ?`,
    )
    .all(ownerId, search, like, like, limit, offset)
}

export function countSessionsForUser(ownerId, search = '') {
  const like = `%${search}%`
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM sessions WHERE owner_id = ? AND (? = '' OR title LIKE ? OR cwd LIKE ?)`,
    )
    .get(ownerId, search, like, like).n
}

/** 按 id 取会话，强制校验归属，防越权。 */
export function getSessionForUser(sessionId, ownerId) {
  return db.prepare('SELECT * FROM sessions WHERE id = ? AND owner_id = ?').get(sessionId, ownerId)
}

export function getSessionAny(sessionId) {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId)
}

export function getEvents(sessionId, { fromSeq = -Infinity } = {}) {
  return db
    .prepare('SELECT seq, type, time, data FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC')
    .all(sessionId, fromSeq)
    .map((r) => ({ ...JSON.parse(r.data), seq: r.seq, type: r.type, time: r.time }))
}

/* ------------------------------------------------------------ 分享链接 */

export function createShareLink(sessionId, ttlDays = config.shareTtlDays) {
  const token = randomBytes(24).toString('base64url')
  const expiresAt = ttlDays > 0 ? Date.now() + ttlDays * 86400_000 : null
  db.prepare(
    'INSERT INTO share_links (token, session_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(token, sessionId, Date.now(), expiresAt)
  db.prepare('UPDATE sessions SET share_token = ? WHERE id = ?').run(token, sessionId)
  return { token, expiresAt }
}

export function resolveShareLink(token) {
  const row = db.prepare('SELECT * FROM share_links WHERE token = ?').get(token)
  if (!row) return null
  if (row.revoked) return { error: '该链接已被撤销' }
  if (row.expires_at && row.expires_at < Date.now()) return { error: '该链接已过期' }
  const session = getSessionAny(row.session_id)
  if (!session) return { error: '会话不存在' }
  const owner = getUserById(session.owner_id)
  return { link: row, session, owner }
}

export function revokeShareLink(token) {
  return db.prepare('UPDATE share_links SET revoked = 1 WHERE token = ?').run(token).changes
}

/* ------------------------------------------------------------ 统计 */

export function statsForUser(ownerId) {
  const s = db
    .prepare(
      `SELECT COUNT(*) AS sessions,
              COALESCE(SUM(event_count),0) AS events,
              COALESCE(SUM(turn_count),0) AS turns,
              MAX(updated_at) AS last
       FROM sessions WHERE owner_id = ?`,
    )
    .get(ownerId)
  return s
}

/* -------------------------------------------------------- 通知邮箱 */

/** 列出某用户的全部通知邮箱。 */
export function listNotifyEmails(userId) {
  return db
    .prepare('SELECT id, email, label, enabled, created_at FROM notify_emails WHERE user_id = ? ORDER BY created_at ASC')
    .all(userId)
}

/** 取出某用户所有启用的收件地址。 */
export function enabledNotifyEmails(userId) {
  return db
    .prepare('SELECT email FROM notify_emails WHERE user_id = ? AND enabled = 1')
    .all(userId)
    .map((r) => r.email)
}

export function addNotifyEmail(userId, email, label = null) {
  const normalized = String(email).trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    const err = new Error('邮箱格式不正确')
    err.code = 'BAD_EMAIL'
    throw err
  }
  const existing = db
    .prepare('SELECT id FROM notify_emails WHERE user_id = ? AND email = ?')
    .get(userId, normalized)
  if (existing) {
    const err = new Error('该邮箱已在列表中')
    err.code = 'DUPLICATE_EMAIL'
    throw err
  }
  const info = db
    .prepare('INSERT INTO notify_emails (user_id, email, label, enabled, created_at) VALUES (?, ?, ?, 1, ?)')
    .run(userId, normalized, label, Date.now())
  return { id: info.lastInsertRowid, email: normalized, label, enabled: 1 }
}

/** 改标签或开关。只允许操作自己的记录。 */
export function updateNotifyEmail(userId, id, { label, enabled }) {
  const row = db.prepare('SELECT * FROM notify_emails WHERE id = ? AND user_id = ?').get(id, userId)
  if (!row) return false
  db.prepare('UPDATE notify_emails SET label = COALESCE(?, label), enabled = COALESCE(?, enabled) WHERE id = ? AND user_id = ?')
    .run(label ?? null, enabled === undefined ? null : (enabled ? 1 : 0), id, userId)
  return true
}

export function removeNotifyEmail(userId, id) {
  return db.prepare('DELETE FROM notify_emails WHERE id = ? AND user_id = ?').run(id, userId).changes
}

/* ------------------------------------------------------------ 任务 */

export function createTask({ id, userId, prompt, cwd }) {
  db.prepare(
    `INSERT INTO chat_tasks (id, user_id, prompt, cwd, status, attempts, created_at)
     VALUES (?, ?, ?, ?, 'queued', 0, ?)`,
  ).run(id, userId, prompt, cwd, Date.now())
  return getTask(id)
}

export function getTask(id) {
  return db.prepare('SELECT * FROM chat_tasks WHERE id = ?').get(id)
}

export function getTaskForUser(id, userId) {
  return db.prepare('SELECT * FROM chat_tasks WHERE id = ? AND user_id = ?').get(id, userId)
}

export function listTasksForUser(userId, limit = 50) {
  return db
    .prepare('SELECT * FROM chat_tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, limit)
}

export function listAllTasks(limit = 100) {
  return db
    .prepare(
      `SELECT t.*, u.email AS owner_email FROM chat_tasks t
       JOIN users u ON u.id = t.user_id ORDER BY t.created_at DESC LIMIT ?`,
    )
    .all(limit)
}

/** 该用户是否有未完成的任务（用于提交时的并发限制）。 */
export function countRunningTasks(userId) {
  return db
    .prepare("SELECT COUNT(*) AS n FROM chat_tasks WHERE user_id = ? AND status IN ('queued','leased')")
    .get(userId).n
}

/**
 * 抢占一个待执行任务：按创建时间取最老的一条，置为 leased 并设租约。
 * 用事务保证同一任务不会被两个 worker 同时领走。
 */
export const leaseNextTask = db.transaction((workerId, leaseMs) => {
  const row = db
    .prepare("SELECT * FROM chat_tasks WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1")
    .get()
  if (!row) return null
  const now = Date.now()
  const info = db
    .prepare(
      `UPDATE chat_tasks SET status='leased', winner=?, lease_until=?, started_at=?, attempts=attempts+1
       WHERE id=? AND status='queued'`,
    )
    .run(workerId, now + leaseMs, now, row.id)
  if (info.changes === 0) return null // 被别人抢走了
  return getTask(row.id)
})

/** worker 心跳续租，避免长任务被执行中被回收。 */
export function renewLease(taskId, workerId, leaseMs) {
  return db
    .prepare("UPDATE chat_tasks SET lease_until = ? WHERE id = ? AND winner = ? AND status = 'leased'")
    .run(Date.now() + leaseMs, taskId, workerId).changes
}

/** worker 回报执行结果。 */
export function completeTask(taskId, workerId, { status, exitCode, resultText, logText, sessionId, error }) {
  return db
    .prepare(
      `UPDATE chat_tasks SET status=?, exit_code=?, result_text=?, log_text=?, session_id=?, error=?, finished_at=?
       WHERE id=? AND winner=? AND status='leased'`,
    )
    .run(status, exitCode ?? null, resultText ?? null, logText ?? null, sessionId ?? null, error ?? null, Date.now(), taskId, workerId).changes
}

/** 租约过期的任务回收重排；超过最大尝试次数则判失败。 */
export function reapExpiredLeases(maxAttempts = 3) {
  const now = Date.now()
  const expired = db
    .prepare("SELECT id, attempts FROM chat_tasks WHERE status='leased' AND lease_until < ?")
    .all(now)
  let requeued = 0
  let failed = 0
  for (const t of expired) {
    if (t.attempts >= maxAttempts) {
      db.prepare("UPDATE chat_tasks SET status='failed', error=?, finished_at=? WHERE id=?")
        .run(`执行节点失联，已重试 ${t.attempts} 次`, now, t.id)
      failed += 1
    } else {
      db.prepare("UPDATE chat_tasks SET status='queued', winner=NULL, lease_until=NULL WHERE id=?")
        .run(t.id)
      requeued += 1
    }
  }
  return { requeued, failed }
}

/** 服务重启后，把本不该属于「已领取」状态的任务放回队列。 */
export function releaseAllLeases() {
  return db
    .prepare("UPDATE chat_tasks SET status='queued', winner=NULL, lease_until=NULL WHERE status='leased'")
    .run().changes
}

export function cancelTaskRow(taskId) {
  return db
    .prepare("UPDATE chat_tasks SET status='cancelled', error='用户取消', finished_at=? WHERE id=? AND status IN ('queued','leased')")
    .run(Date.now(), taskId).changes
}

/* ------------------------------------------------------------ Worker */

export function registerWorker({ id, name, tokenHash, version }) {
  db.prepare(
    `INSERT INTO workers (id, name, token_hash, version, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, token_hash=excluded.token_hash, version=excluded.version, revoked=0`,
  ).run(id, name, tokenHash, version ?? null, Date.now(), Date.now())
  return getWorker(id)
}

export function getWorker(id) {
  return db.prepare('SELECT * FROM workers WHERE id = ?').get(id)
}

export function findWorkerByTokenHash(tokenHash) {
  return db.prepare('SELECT * FROM workers WHERE token_hash = ? AND revoked = 0').get(tokenHash)
}

export function touchWorker(id, ip, version) {
  db.prepare('UPDATE workers SET last_seen_at = ?, last_ip = ?, version = COALESCE(?, version) WHERE id = ?')
    .run(Date.now(), ip ?? null, version ?? null, id)
}

export function listWorkers() {
  return db.prepare('SELECT id, name, last_seen_at, last_ip, version, created_at, revoked FROM workers ORDER BY created_at ASC').all()
}

export function revokeWorker(id) {
  return db.prepare('UPDATE workers SET revoked = 1 WHERE id = ?').run(id).changes
}

/* --------------------------------------------------------- API 密钥 */

export function createApiKey(userId, name, keyHash, prefix) {
  const id = randomUUID()
  db.prepare('INSERT INTO api_keys (id, user_id, name, key_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, userId, name, keyHash, prefix, Date.now())
  return { id, name, prefix }
}

export function listApiKeys(userId) {
  return db
    .prepare('SELECT id, name, prefix, created_at, last_used_at, revoked FROM api_keys WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId)
}

export function findApiKeyByPrefix(prefix) {
  return db.prepare('SELECT * FROM api_keys WHERE prefix = ? AND revoked = 0').get(prefix)
}

export function touchApiKey(id) {
  db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), id)
}

export function revokeApiKey(userId, id) {
  return db.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ? AND user_id = ?').run(id, userId).changes
}

/* ------------------------------------------------------------ 审计 */

export function audit({ userId = null, actorEmail = null, action, detail = null, ip = null }) {
  db.prepare('INSERT INTO audit_log (user_id, actor_email, action, detail, ip, time) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, actorEmail, action, detail, ip, Date.now())
}

export function listAudit(limit = 200) {
  return db.prepare('SELECT * FROM audit_log ORDER BY time DESC LIMIT ?').all(limit)
}

/* --------------------------------------------------- 管理员查询 */

export function listAllUsers() {
  return db
    .prepare(
      `SELECT u.id, u.email, u.display_name, u.created_at, u.is_admin,
              (SELECT COUNT(*) FROM sessions s WHERE s.owner_id = u.id) AS session_count,
              (SELECT COUNT(*) FROM notify_emails n WHERE n.user_id = u.id) AS notify_count
       FROM users u ORDER BY u.created_at ASC`,
    )
    .all()
}

export function setUserAdmin(userId, isAdmin) {
  return db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, userId).changes
}

export function listAllSessions({ limit = 100, offset = 0, search = '' } = {}) {
  const like = `%${search}%`
  return db
    .prepare(
      `SELECT s.id, s.title, s.cwd, s.created_at, s.updated_at, s.event_count, s.turn_count,
              u.email AS owner_email
       FROM sessions s JOIN users u ON u.id = s.owner_id
       WHERE (? = '' OR s.title LIKE ? OR s.cwd LIKE ? OR u.email LIKE ?)
       ORDER BY s.updated_at DESC LIMIT ? OFFSET ?`,
    )
    .all(search, like, like, like, limit, offset)
}

export function globalStats() {
  return db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM sessions) AS sessions,
        (SELECT COUNT(*) FROM events) AS events,
        (SELECT COUNT(*) FROM chat_tasks) AS tasks,
        (SELECT COUNT(*) FROM chat_tasks WHERE status='leased') AS running,
        (SELECT COUNT(*) FROM chat_tasks WHERE status='queued') AS queued,
        (SELECT COUNT(*) FROM workers WHERE revoked=0) AS workers,
        (SELECT COUNT(*) FROM mail_log WHERE ok=1) AS mails_ok,
        (SELECT COUNT(*) FROM mail_log WHERE ok=0) AS mails_fail`,
    )
    .get()
}

export function listMailLog(limit = 100) {
  return db
    .prepare(
      `SELECT m.id, m.session_id, m."to", m.sent_at, m.ok, m.error, s.title
       FROM mail_log m LEFT JOIN sessions s ON s.id = m.session_id
       ORDER BY m.sent_at DESC LIMIT ?`,
    )
    .all(limit)
}
