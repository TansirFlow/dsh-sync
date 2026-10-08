/**
 * 把 DSH 的 session 事件流投影成"聊天记录"。
 *
 * 只关注人看得懂的内容：用户消息、助手回复、工具调用、工具结果、会话标题。
 * 其余事件（request/context、sandbox/mode 等）作为元信息单独归类，默认折叠。
 */

const INTERNAL_SOURCE_KINDS = new Set(['runtime-context'])

/** 判断一条 user/message 是否属于"系统注入"，不应算作用户发言。 */
function isInjectedUserMessage(data) {
  const kind = data?.source?.kind
  if (kind && INTERNAL_SOURCE_KINDS.has(kind)) return true
  const text = extractText(data?.content)
  if (text.startsWith('Current runtime context.')) return true
  if (text.startsWith('<system-reminder>')) return true
  return false
}

export function extractText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
}

export function extractImages(content) {
  if (!Array.isArray(content)) return []
  return content.filter((p) => p && (p.type === 'image' || p.type === 'image_url'))
}

/**
 * @param {Array<{type:string,seq:number,time:number,data:any}>} events
 * @returns {{meta:object, messages:Array, toolCalls:Map, stats:object}}
 */
export function projectTranscript(events) {
  const header = events.find((e) => e.type === 'session')
  const messages = [] // 有序的展示条目
  const toolCalls = new Map() // toolCallId -> {name, args, result}
  const titles = []

  for (const ev of events) {
    const d = ev.data ?? {}
    switch (ev.type) {
      case 'user/message': {
        if (isInjectedUserMessage(d)) break
        const text = extractText(d.content)
        if (!text.trim()) break
        messages.push({
          kind: 'user',
          seq: ev.seq,
          time: ev.time,
          text,
          images: extractImages(d.content).length,
        })
        break
      }

      case 'assistant/message': {
        const m = d.message ?? {}
        const content = Array.isArray(m.content) ? m.content : []
        const text = extractText(content)
        const reasoning = m.reasoning ?? null
        // DSH 实际使用 'tool-call'（连字符）
        const calls = content.filter((p) => p && (p.type === 'tool-call' || p.type === 'tool_call'))
        if (!text.trim() && calls.length === 0) break
        messages.push({
          kind: 'assistant',
          seq: ev.seq,
          time: ev.time,
          turn: d.turn,
          step: d.step,
          text,
          reasoning: typeof reasoning === 'string' ? reasoning : null,
          toolCalls: calls.map((c) => ({
            id: c.id ?? c.toolCallId ?? null,
            name: c.name ?? c.toolName ?? 'unknown',
            args: c.arguments ?? c.args ?? null,
          })),
        })
        for (const c of calls) {
          const id = c.id ?? c.toolCallId
          if (id) toolCalls.set(id, { name: c.name ?? c.toolName ?? 'unknown', args: c.arguments ?? c.args ?? null })
        }
        break
      }

      // 独立的工具调用事件（DSH 用 callId）。
      // assistant/message 里已经带了 tool-call 部件，这里只在尚未登记时才单列，
      // 否则同一次调用会在页面上出现两遍。
      case 'tool/call': {
        const id = d.callId ?? d.id ?? d.toolCallId
        const known = id ? toolCalls.get(id) : null
        if (id) toolCalls.set(id, { name: d.name ?? d.toolName ?? 'unknown', args: d.arguments ?? d.args ?? null })
        if (!known) {
          messages.push({
            kind: 'tool_call',
            seq: ev.seq,
            time: ev.time,
            id,
            name: d.name ?? d.toolName ?? 'unknown',
            args: d.arguments ?? d.args ?? null,
          })
        }
        break
      }

      case 'tool/result': {
        // 结果内容嵌在 data.message 里
        const msg = d.message ?? d
        const id = msg.toolCallId ?? d.callId ?? d.id
        const rec = id ? toolCalls.get(id) : null
        if (rec) rec.result = msg
        const text = extractText(msg.content) || (typeof msg.output === 'string' ? msg.output : '')
        messages.push({
          kind: 'tool_result',
          seq: ev.seq,
          time: ev.time,
          id,
          name: rec?.name ?? msg.name ?? 'unknown',
          text,
          isError: Boolean(msg.isError ?? d.isError),
        })
        break
      }

      case 'session/title': {
        if (d.title) titles.push({ title: d.title, seq: ev.seq })
        break
      }

      case 'turn/end': {
        messages.push({
          kind: 'turn_end',
          seq: ev.seq,
          time: ev.time,
          turn: d.turn,
          reason: d.reason?.kind ?? null,
        })
        break
      }
    }
  }

  const userMsgs = messages.filter((m) => m.kind === 'user')
  const assistantMsgs = messages.filter((m) => m.kind === 'assistant')
  const toolResults = messages.filter((m) => m.kind === 'tool_result')

  return {
    meta: {
      id: header?.id ?? null,
      createdAt: header?.createdAt ?? null,
      cwd: header?.cwd ?? null,
      agentPreset: header?.agentPreset ?? null,
      version: header?.version ?? null,
    },
    title: titles.length ? titles[titles.length - 1].title : null,
    messages,
    stats: {
      totalEvents: events.length,
      userMessages: userMsgs.length,
      assistantMessages: assistantMsgs.length,
      toolCalls: toolResults.length,
      turns: new Set(messages.filter((m) => m.kind === 'turn_end').map((m) => m.turn)).size,
    },
  }
}

/** 生成邮件正文用的纯文本预览。 */
export function buildPreview(transcript, maxChars = 300) {
  const firstUser = transcript.messages.find((m) => m.kind === 'user')
  const firstAssistant = transcript.messages.find((m) => m.kind === 'assistant' && m.text.trim())
  const parts = []
  if (firstUser) parts.push(`用户：${firstUser.text}`)
  if (firstAssistant) parts.push(`助手：${firstAssistant.text}`)
  const joined = parts.join('\n\n').replace(/\s+/g, ' ').trim()
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}…` : joined
}

/** 事件类型统计，用于详情页的"原始事件"面板。 */
export function eventTypeHistogram(events) {
  const map = new Map()
  for (const e of events) map.set(e.type, (map.get(e.type) ?? 0) + 1)
  return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count }))
}
