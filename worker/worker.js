#!/usr/bin/env node
/**
 * DSH Sync Worker —— 运行在**本地 DSH 机器**上。
 *
 * 云端服务碰不到本地进程，所以任务方向是反的：worker 主动向云端长轮询，
 * 领到任务后本地 spawn `dsh --profile headless` 执行，再把结果回报给云端。
 *
 * 用法：
 *   node worker.js --cloud http://<云端地址>:8090 --worker-id home-linux --token <worker-token>
 *   或用环境变量 DSH_SYNC_CLOUD / DSH_SYNC_WORKER_ID / DSH_SYNC_WORKER_TOKEN
 *
 * 安全：
 *   - 只接受允许根目录内的 cwd；
 *   - 硬超时，超时杀整个进程组；
 *   - 环境变量白名单，只透传模型凭据；
 *   - 单机并发上限，避免打满。
 */

import { spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

/* ---------------------------------------------------------------- 配置 */

const { values: argv } = parseArgs({
  options: {
    cloud: { type: 'string' },
    'worker-id': { type: 'string' },
    token: { type: 'string' },
    concurrency: { type: 'string' },
    'poll-interval': { type: 'string' },
    'lease-seconds': { type: 'string' },
    timeout: { type: 'string' },
    root: { type: 'string', multiple: true },
    cli: { type: 'string' },
    node: { type: 'string' },
    profile: { type: 'string' },
    once: { type: 'boolean' },
    verbose: { type: 'boolean' },
  },
  allowPositionals: false,
})

function env(name, fallback) {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

const cfg = {
  cloud: (argv.cloud ?? env('DSH_SYNC_CLOUD', 'http://127.0.0.1:8090')).replace(/\/$/, ''),
  workerId: argv['worker-id'] ?? env('DSH_SYNC_WORKER_ID', ''),
  token: argv.token ?? env('DSH_SYNC_WORKER_TOKEN', ''),
  concurrency: Number(argv.concurrency ?? env('DSH_SYNC_WORKER_CONCURRENCY', '1')),
  pollIntervalMs: Number(argv['poll-interval'] ?? env('DSH_SYNC_WORKER_POLL_MS', '3000')),
  leaseSeconds: Number(argv['lease-seconds'] ?? env('DSH_SYNC_WORKER_LEASE_SECONDS', '120')),
  timeoutMs: Number(argv.timeout ?? env('DSH_SYNC_WORKER_TIMEOUT_MS', '900000')),
  roots: (argv.root ?? [env('DSH_SYNC_WORKER_ROOTS', process.cwd())])
    .flatMap((s) => String(s).split(','))
    .map((s) => s.trim())
    .filter(Boolean),
  cli: argv.cli ?? env('DSH_SYNC_CLI', ''),
  nodePath: argv.node ?? env('DSH_SYNC_NODE', process.execPath),
  profile: argv.profile ?? env('DSH_SYNC_WORKER_PROFILE', 'headless'),
  once: Boolean(argv.once),
  verbose: Boolean(argv.verbose ?? env('DSH_SYNC_WORKER_VERBOSE', 'false') === 'true'),
  envPassthrough: env('DSH_SYNC_WORKER_ENV', 'NEW_API_API_KEY,DEEPSEEK_API_KEY,PATH,HOME')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
}

function log(...a) {
  console.log(`[worker ${new Date().toISOString()}]`, ...a)
}
function debug(...a) {
  if (cfg.verbose) console.log(`[worker ${new Date().toISOString()}]`, ...a)
}

if (!cfg.workerId) {
  console.error('缺少 --worker-id（或 DSH_SYNC_WORKER_ID）')
  process.exit(1)
}
if (!cfg.token) {
  console.error('缺少 --token（或 DSH_SYNC_WORKER_TOKEN）')
  process.exit(1)
}
if (!cfg.cli) {
  console.error('缺少 --cli（或 DSH_SYNC_CLI）：指向 DSH 的 apps/cli/lib/bin.js')
  process.exit(1)
}

/* ------------------------------------------------------------ 云端通信 */

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${cfg.token}`,
  'X-Worker-Id': cfg.workerId,
}

async function callCloud(path, init = {}) {
  const res = await fetch(`${cfg.cloud}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { raw: text }
  }
  if (!res.ok) {
    const err = new Error(`云端返回 ${res.status}: ${body?.error ?? text.slice(0, 200)}`)
    err.status = res.status
    throw err
  }
  return body
}

/* ------------------------------------------------------------ 工作目录 */

function resolveCwd(input) {
  const raw = input && String(input).trim() ? String(input).trim() : cfg.roots[0]
  const abs = resolve(raw)
  let real = abs
  try {
    if (existsSync(abs)) real = realpathSync(abs)
  } catch {
    /* 按字面 */
  }
  const ok = cfg.roots.some((root) => {
    let r = resolve(root)
    try {
      if (existsSync(r)) r = realpathSync(r)
    } catch {
      /* 按字面 */
    }
    return real === r || real.startsWith(r + sep)
  })
  if (!ok) throw new Error(`工作目录不在允许范围内：${real}（允许：${cfg.roots.join(', ')}）`)
  if (!existsSync(real)) throw new Error(`工作目录不存在：${real}`)
  return real
}

/* ------------------------------------------------------------ 执行任务 */

function buildEnv() {
  const env = { TERM: 'dumb', NODE_ENV: 'production' }
  for (const key of cfg.envPassthrough) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  env.PATH ??= '/usr/local/bin:/usr/bin:/bin'
  env.HOME ??= process.env.HOME
  return env
}

/** spawn headless 并等它结束；期间定时续租。 */
async function executeTask(task) {
  const cwd = resolveCwd(task.cwd)
  const args = [cfg.cli, '--profile', cfg.profile, '--json', task.prompt]

  debug(`执行任务 ${task.id}，cwd=${cwd}`)
  const child = spawn(cfg.nodePath, args, {
    cwd,
    env: buildEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })

  let stdout = ''
  let stderr = ''
  const MAX = 400_000
  child.stdout.on('data', (b) => {
    if (stdout.length < MAX) stdout += b.toString('utf8')
  })
  child.stderr.on('data', (b) => {
    if (stderr.length < MAX) stderr += b.toString('utf8')
  })

  // 超时保护
  let killed = false
  const timer = setTimeout(() => {
    killed = true
    killGroup(child)
  }, cfg.timeoutMs)

  // 续租：长任务要持续告诉云端"我还活着"
  const renew = setInterval(() => {
    callCloud(`/api/worker/tasks/${task.id}/renew`, {
      method: 'POST',
      body: JSON.stringify({ leaseSeconds: cfg.leaseSeconds }),
    }).catch((e) => debug('续租失败:', e.message))
  }, Math.max(10_000, (cfg.leaseSeconds * 1000) / 2))

  const { code, signal } = await new Promise((res) => {
    child.on('error', (err) => {
      stderr += `\n[spawn error] ${err.message}`
      res({ code: -1, signal: null })
    })
    child.on('close', (c, s) => res({ code: c, signal: s }))
  })

  clearTimeout(timer)
  clearInterval(renew)

  const sessionId = extractSessionId(stdout)
  const resultText = extractResult(stdout) || (code === 0 ? stdout.trim() : '')

  let status = 'succeeded'
  let error = null
  if (killed) {
    status = 'timeout'
    error = `执行超时（超过 ${Math.round(cfg.timeoutMs / 1000)} 秒）`
  } else if (code !== 0) {
    status = 'failed'
    error = `进程退出码 ${code}${signal ? ` (${signal})` : ''}${stderr ? `\n${stderr.slice(-800)}` : ''}`
  }

  return { status, exitCode: code, resultText, logText: stdout, sessionId, error }
}

function killGroup(child) {
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    try {
      child.kill('SIGTERM')
    } catch {
      /* 已退出 */
    }
  }
  setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      /* 已退出 */
    }
  }, 5000).unref?.()
}

/** 从 --json 事件流里取会话 id。 */
function extractSessionId(stdout) {
  for (const line of stdout.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const o = JSON.parse(t)
      const id = o.sessionId ?? o.session_id ?? o.session?.id
      if (typeof id === 'string' && id.startsWith('session-')) return id
    } catch {
      /* 跳过 */
    }
  }
  return null
}

/** 从事件流里取最终回答文本。 */
function extractResult(stdout) {
  let last = null
  for (const line of stdout.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const o = JSON.parse(t)
      // 兼容几种可能的形状
      const cand =
        (o.type === 'assistant/message' && o.data?.message?.content) ||
        (o.type === 'message' && o.content) ||
        o.result ||
        o.text
      if (typeof cand === 'string') last = cand
      else if (Array.isArray(cand)) {
        const joined = cand.filter((p) => p?.type === 'text').map((p) => p.text).join('')
        if (joined) last = joined
      }
    } catch {
      /* 跳过 */
    }
  }
  return last
}

/* ---------------------------------------------------------------- 主循环 */

let inFlight = 0
let stopping = false

async function pullOnce() {
  const body = await callCloud('/api/worker/tasks/next', {
    method: 'POST',
    body: JSON.stringify({ leaseSeconds: cfg.leaseSeconds }),
  })
  const task = body?.task
  if (!task) return false

  inFlight += 1
  log(`领到任务 ${task.id}（${String(task.prompt).slice(0, 50)}…）`)
  ;(async () => {
    try {
      const out = await executeTask(task)
      await callCloud(`/api/worker/tasks/${task.id}/complete`, {
        method: 'POST',
        body: JSON.stringify(out),
      })
      log(`任务 ${task.id} 完成：${out.status}${out.sessionId ? ` (${out.sessionId})` : ''}`)
    } catch (err) {
      log(`任务 ${task.id} 出错：${err.message}`)
      try {
        await callCloud(`/api/worker/tasks/${task.id}/complete`, {
          method: 'POST',
          body: JSON.stringify({ status: 'failed', error: err.message }),
        })
      } catch (e2) {
        log(`回报失败：${e2.message}`)
      }
    } finally {
      inFlight -= 1
    }
  })()
  return true
}

async function heartbeat() {
  try {
    await callCloud('/api/worker/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ version: process.version, concurrency: cfg.concurrency }),
    })
    debug('心跳正常')
  } catch (err) {
    log(`心跳失败：${err.message}`)
  }
}

async function main() {
  log(`启动：cloud=${cfg.cloud} id=${cfg.workerId} 并发=${cfg.concurrency}`)
  log(`DSH CLI：${cfg.cli}（profile=${cfg.profile}）`)
  log(`允许的根目录：${cfg.roots.join(', ')}`)

  await heartbeat()

  const hb = setInterval(heartbeat, 30_000)

  if (cfg.once) {
    const got = await pullOnce()
    // 等手头任务跑完
    while (inFlight > 0) await new Promise((r) => setTimeout(r, 500))
    clearInterval(hb)
    log(got ? '单次轮询完成' : '队列为空')
    process.exit(0)
  }

  const loop = setInterval(async () => {
    if (stopping) return
    if (inFlight >= cfg.concurrency) return
    try {
      let more = true
      while (more && inFlight < cfg.concurrency) {
        more = await pullOnce()
      }
    } catch (err) {
      // 云端不可达时不要刷屏
      if (err.status !== 401) debug(`拉取失败：${err.message}`)
      else log('鉴权失败：worker token 无效或被撤销')
    }
  }, cfg.pollIntervalMs)

  const shutdown = () => {
    if (stopping) return
    stopping = true
    log('收到退出信号，停止拉取新任务')
    clearInterval(loop)
    clearInterval(hb)
    const wait = setInterval(() => {
      if (inFlight === 0) {
        clearInterval(wait)
        process.exit(0)
      }
    }, 500)
    setTimeout(() => process.exit(0), 30_000)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('[worker] 致命错误:', err)
  process.exit(1)
})
