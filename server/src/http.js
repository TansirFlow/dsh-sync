/**
 * 极简 HTTP 路由与工具：不引第三方框架，减少部署面。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/* ------------------------------------------------------------ 响应工具 */

export function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(payload)
}

export function html(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  })
  res.end(body)
}

export function text(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  })
  res.end(body)
}

export function redirect(res, location, headers = {}) {
  res.writeHead(302, { Location: location, ...headers })
  res.end()
}

/** 读取请求体，带体积上限，防止内存被打爆。 */
export async function readBody(req, limitBytes = 64 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limitBytes) {
      const err = new Error('请求体过大')
      err.code = 'BODY_TOO_LARGE'
      throw err
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export async function readJson(req, limitBytes) {
  const raw = await readBody(req, limitBytes)
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    const err = new Error('JSON 解析失败')
    err.code = 'BAD_JSON'
    throw err
  }
}

export function parseCookies(req) {
  const header = req.headers.cookie
  const out = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}

/* -------------------------------------------------------------- 口令 */

/** 会话 cookie 的签名，防止伪造。 */
export function signValue(value, secret) {
  const mac = createHash('sha256').update(`${value}.${secret}`).digest('base64url')
  return `${value}.${mac}`
}

export function unsignValue(signed, secret) {
  if (typeof signed !== 'string') return null
  const idx = signed.lastIndexOf('.')
  if (idx <= 0) return null
  const value = signed.slice(0, idx)
  const mac = signed.slice(idx + 1)
  const expected = createHash('sha256').update(`${value}.${secret}`).digest('base64url')
  if (mac.length !== expected.length) return null
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null
  return value
}

export function randomToken(bytes = 24) {
  return randomBytes(bytes).toString('base64url')
}

/** 常量时间比较两个字符串（用于 ingest token 校验）。 */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''))
  const bb = Buffer.from(String(b ?? ''))
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/* ---------------------------------------------------------- 简单限流 */

const buckets = new Map()

/** 进程内滑动窗口限流，够用且不引依赖。 */
export function rateLimit(key, max, windowMs) {
  const now = Date.now()
  const entry = buckets.get(key)
  if (!entry || now > entry.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return { ok: true, remaining: max - 1 }
  }
  entry.count += 1
  if (entry.count > max) return { ok: false, remaining: 0, retryAfter: entry.resetAt - now }
  return { ok: true, remaining: max - entry.count }
}

export function clientIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown'
  )
}
