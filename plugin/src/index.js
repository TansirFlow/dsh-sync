/**
 * DSH Sync 推送插件。
 *
 * 挂在 DSH 里，订阅 `session/created` 与 `session/event`，把会话事件**批量、异步、带重试**
 * 地推送到 DSH Sync 服务。设计要点：
 *
 *  - 绝不阻塞主流程：推送走独立队列，失败只记录日志，不影响 agent 运行。
 *  - 批量 + 去抖：同一会话的事件聚合成一批再发，降低请求数。
 *  - 断线重试：指数退避，服务恢复后自动补推。
 *  - 首条消息触发通知：服务端据此建分享链接并发邮件。
 *
 * 所有可调参数集中在 Config，通过 profile 的 cordis.patch.yml 覆盖。
 */

export const name = 'dsh-sync'

/** 依赖注入：只需要 cordis 基础能力，不依赖任何业务服务。 */
export const inject = []

/**
 * Config 采用 Standard Schema 接口（Cordis 用 `Config['~standard'].validate()` 校验）。
 * 这里手写一个最小实现，避免依赖 @deepseek-ai/schemastery —— 插件被放在 profile 的
 * node_modules 下时不一定能解析到该包。
 */
function makeConfigSchema(defaults) {
  return {
    '~standard': {
      version: 1,
      vendor: 'dsh-sync-plugin',
      validate(input) {
        const raw = input === undefined || input === null ? {} : input
        if (typeof raw !== 'object' || Array.isArray(raw)) {
          return { issues: [{ message: 'dsh-sync 配置必须是一个对象' }] }
        }
        const out = {}
        const issues = []
        for (const [key, fallback] of Object.entries(defaults)) {
          const v = raw[key]
          if (v === undefined) {
            out[key] = fallback
            continue
          }
          const want = typeof fallback
          if (want === 'number') {
            const n = Number(v)
            if (!Number.isFinite(n)) issues.push({ message: `${key} 必须是数字` })
            else out[key] = n
          } else if (want === 'boolean') {
            if (typeof v === 'boolean') out[key] = v
            else if (v === 'true' || v === 'false') out[key] = v === 'true'
            else issues.push({ message: `${key} 必须是布尔值` })
          } else {
            out[key] = String(v)
          }
        }
        // 保留调用方传入的额外字段
        for (const [k, v] of Object.entries(raw)) {
          if (!(k in out)) out[k] = v
        }
        if (issues.length) return { issues }
        return { value: out }
      },
    },
  }
}

/** 从环境变量读取配置，profile 里也可显式覆盖。 */
function env(name, fallback) {
  const v = typeof process !== 'undefined' ? process.env?.[name] : undefined
  return v === undefined || v === '' ? fallback : v
}

export const Config = makeConfigSchema({
  endpoint: env('DSH_SYNC_ENDPOINT', 'http://localhost:8090/api/ingest'),
  token: env('DSH_SYNC_INGEST_TOKEN', ''),
  ownerEmail: env('DSH_SYNC_OWNER_EMAIL', ''),
  notifyTo: env('DSH_SYNC_NOTIFY_TO', ''),
  /** 聚合窗口（毫秒）：窗口内的事件合成一批推送。 */
  flushIntervalMs: Number(env('DSH_SYNC_FLUSH_MS', '1200')),
  /** 单批最大事件数。 */
  maxBatch: Number(env('DSH_SYNC_MAX_BATCH', '200')),
  /** 失败重试上限与退避基数。 */
  maxRetries: Number(env('DSH_SYNC_MAX_RETRIES', '5')),
  retryBaseMs: Number(env('DSH_SYNC_RETRY_BASE_MS', '1500')),
  /** 启动时是否回灌已有会话（首次部署很有用）。 */
  backfillOnStart: env('DSH_SYNC_BACKFILL', 'false') === 'true',
  debug: env('DSH_SYNC_DEBUG', 'false') === 'true',
})

/**
 * 每个会话一个推送器：缓存头部信息、事件缓冲、以及推送状态。
 */
class SessionPusher {
  constructor(ctx, config, session) {
    this.ctx = ctx
    this.config = config
    this.sessionId = session.id
    this.header = {
      id: session.id,
      cwd: session.cwd ?? null,
      createdAt: session.header?.createdAt ?? Date.now(),
      agentPreset: session.header?.agentPreset ?? null,
    }
    this.buffer = []
    this.timer = null
    this.sending = false
    this.retries = 0
    this.title = null
    this.closed = false
  }

  setHeaderFromEvent(event) {
    if (event.type === 'session/title' && event.data?.title) {
      this.title = event.data.title
    }
  }

  push(event) {
    if (this.closed) return
    this.setHeaderFromEvent(event)
    this.buffer.push({
      seq: event.seq,
      type: event.type,
      time: event.time ?? null,
      data: event.data ?? null,
    })
    // 事件太多时不等待窗口，立即发一批，避免内存堆积
    if (this.buffer.length >= this.config.maxBatch) {
      void this.flush()
      return
    }
    this.schedule()
  }

  schedule() {
    if (this.timer || this.closed) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, this.config.flushIntervalMs)
    // 不要因为这个定时器拖住进程退出
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  async flush() {
    if (this.sending || this.buffer.length === 0 || this.closed) return
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.sending = true
    const batch = this.buffer
    this.buffer = []

    const payload = {
      sessionId: this.sessionId,
      ownerEmail: this.config.ownerEmail,
      notifyTo: this.config.notifyTo || undefined,
      title: this.title ?? undefined,
      cwd: this.header.cwd,
      agentPreset: this.header.agentPreset,
      createdAt: this.header.createdAt,
      events: batch,
    }

    try {
      const res = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.token}`,
        },
        body: JSON.stringify(payload),
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`)
      }

      const result = await res.json().catch(() => ({}))
      this.retries = 0
      if (this.config.debug) {
        this.ctx.logger?.debug?.(
          `[dsh-sync] ${this.sessionId} 推送 ${batch.length} 条,新增 ${result.inserted ?? '?'}`,
        )
      }
      if (result.notified) {
        this.ctx.logger?.info?.(`[dsh-sync] 已发送新会话通知邮件 -> ${this.config.notifyTo || this.config.ownerEmail}`)
      }
    } catch (err) {
      this.retries += 1
      if (this.retries > this.config.maxRetries) {
        this.ctx.logger?.warn?.(
          `[dsh-sync] ${this.sessionId} 推送失败已放弃(${this.retries} 次): ${err.message}`,
        )
        this.retries = 0
      } else {
        // 回灌到缓冲区头部，等待退避后重试
        this.buffer = batch.concat(this.buffer)
        const delay = this.config.retryBaseMs * 2 ** (this.retries - 1)
        if (this.config.debug) {
          this.ctx.logger?.debug?.(`[dsh-sync] ${this.sessionId} 第 ${this.retries} 次重试,${delay}ms 后`)
        }
        this.timer = setTimeout(() => {
          this.timer = null
          void this.flush()
        }, delay)
        if (typeof this.timer.unref === 'function') this.timer.unref()
      }
    } finally {
      this.sending = false
      if (this.buffer.length > 0 && !this.timer) this.schedule()
    }
  }

  /**
   * 立即把缓冲区推完，并等待完成。用于 session/flush 这种必须落地的时刻。
   * 与 flush() 的区别：这里会循环直到缓冲区真的空了（或重试耗尽）。
   */
  async drain() {
    if (this.closed) {
      this.closed = false // 允许在 flush 阶段继续发送
    }
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    // 等正在进行的发送结束
    for (let i = 0; i < 200 && this.sending; i++) {
      await new Promise((r) => setTimeout(r, 25))
    }
    let guard = 0
    while (this.buffer.length > 0 && guard < 10) {
      guard += 1
      await this.flush()
      if (this.buffer.length > 0 && !this.sending) {
        // flush 里若安排了退避定时器，这里直接等它
        await new Promise((r) => setTimeout(r, 200))
      }
    }
    if (this.buffer.length > 0) {
      this.ctx.logger?.warn?.(`[dsh-sync] ${this.sessionId} flush 后仍有 ${this.buffer.length} 条未发送`)
    }
  }

  async close() {
    this.closed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    // 尽力把剩余事件送出去（不重试，避免退出被拖住）
    if (this.buffer.length > 0) {
      const batch = this.buffer
      this.buffer = []
      try {
        await fetch(this.config.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.token}`,
          },
          body: JSON.stringify({
            sessionId: this.sessionId,
            ownerEmail: this.config.ownerEmail,
            title: this.title ?? undefined,
            cwd: this.header.cwd,
            createdAt: this.header.createdAt,
            events: batch,
          }),
        })
      } catch {
        // 退出路径上静默失败
      }
    }
  }
}

export function apply(ctx, config = {}) {
  const cfg = { ...Config, ...config }

  if (!cfg.token) {
    ctx.logger?.warn?.('[dsh-sync] 未配置 DSH_SYNC_INGEST_TOKEN,插件不会推送')
    return
  }
  if (!cfg.ownerEmail) {
    ctx.logger?.warn?.('[dsh-sync] 未配置 DSH_SYNC_OWNER_EMAIL,插件不会推送')
    return
  }

  const pushers = new Map()

  /** 取出或创建某个会话的推送器。 */
  const pusherFor = (session) => {
    let p = pushers.get(session.id)
    if (!p) {
      p = new SessionPusher(ctx, cfg, session)
      pushers.set(session.id, p)
      ctx.logger?.debug?.(`[dsh-sync] 开始跟踪会话 ${session.id}`)
    }
    return p
  }

  // 会话被创建时立刻登记；若配置了回灌，把已有事件一次性推上去
  ctx.on('session/created', (session) => {
    const p = pusherFor(session)
    if (cfg.backfillOnStart) {
      try {
        const events = session.events ?? session.read?.() ?? []
        for (const ev of events) p.push(ev)
      } catch {
        // 回灌失败不影响后续实时推送
      }
    }
  })

  // 核心：每条持久化事件都推一次（内部做了聚合）
  ctx.on('session/event', (session, event) => {
    // seed 事件不推（它们不属于本次对话）
    if (event?.type === 'session' && event?.seq === undefined) return
    pusherFor(session).push(event)
  })

  // 关键：session/flush 是持久化屏障，进程退出/空闲前必然会走到这里。
  // 不在这里冲刷的话，最后一批事件（含助手回复）会随进程退出一起丢失。
  ctx.on('session/flush', async (session) => {
    const p = pushers.get(session.id)
    if (!p) return
    await p.drain()
  })

  // 会话关闭时冲刷并释放
  ctx.on('session/disposed', (session) => {
    const p = pushers.get(session.id)
    if (!p) return
    pushers.delete(session.id)
    void p.close()
  })

  // 卸载插件时把所有缓冲刷完
  ctx.on('dispose', () => {
    const all = [...pushers.values()]
    pushers.clear()
    return Promise.allSettled(all.map((p) => p.close()))
  })

  ctx.logger?.info?.(`[dsh-sync] 已启用,推送目标 ${cfg.endpoint},归属 ${cfg.ownerEmail}`)
}
