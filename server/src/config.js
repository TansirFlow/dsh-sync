/**
 * 配置加载：全部来自环境变量，便于以 systemd 方式部署。
 */

import { readFileSync, existsSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

function env(name, fallback) {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

/** 若 secret 文件不存在则生成并落盘，保证重启后 token 仍可校验。 */
function persistentSecret(path, envValue) {
  if (envValue) return envValue
  if (existsSync(path)) return readFileSync(path, 'utf8').trim()
  const generated = randomBytes(32).toString('hex')
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, generated, { mode: 0o600 })
    chmodSync(path, 0o600)
  } catch {
    // 只读文件系统：退化为进程内密钥（重启后旧链接失效）
  }
  return generated
}

const DATA_DIR = env('DSH_SYNC_DATA_DIR', '/var/lib/dsh-sync')

export const config = {
  dataDir: DATA_DIR,
  dbPath: env('DSH_SYNC_DB', `${DATA_DIR}/dsh-sync.db`),
  port: Number(env('DSH_SYNC_PORT', '8090')),
  host: env('DSH_SYNC_HOST', '0.0.0.0'),

  /** 对外可访问的基地址，用于拼接邮件里的链接。部署时务必改成真实域名。 */
  publicBaseUrl: env('DSH_SYNC_PUBLIC_URL', 'http://localhost:8090'),

  /** 插件推送用的共享密钥。 */
  ingestToken: env('DSH_SYNC_INGEST_TOKEN', ''),

  /** 会话分享链接的签名密钥。 */
  shareSecret: persistentSecret(`${DATA_DIR}/share.secret`, env('DSH_SYNC_SHARE_SECRET', '')),

  /** 分享链接默认有效期（天）。 */
  shareTtlDays: Number(env('DSH_SYNC_SHARE_TTL_DAYS', '30')),

  smtp: {
    host: env('DSH_SYNC_SMTP_HOST', 'smtp.zoho.com'),
    port: Number(env('DSH_SYNC_SMTP_PORT', '465')),
    secure: env('DSH_SYNC_SMTP_SECURE', 'true') !== 'false',
    user: env('DSH_SYNC_SMTP_USER', ''),
    pass: env('DSH_SYNC_SMTP_PASS', ''),
    from: env('DSH_SYNC_SMTP_FROM', ''),
  },

  /** 新会话通知的默认收件人（可被插件推送时覆盖）。 */
  defaultNotifyTo: env('DSH_SYNC_NOTIFY_TO', ''),

  /** 邮件通知总开关，便于本地调试时关闭。 */
  mailEnabled: env('DSH_SYNC_MAIL_ENABLED', 'true') !== 'false',

  /** 网页端发起对话（headless 执行器）相关配置。 */
  task: {
    /** 是否允许从网页端发起对话。 */
    enabled: env('DSH_SYNC_TASK_ENABLED', 'true') !== 'false',
    nodePath: env('DSH_SYNC_NODE', process.execPath),
    cliPath: env('DSH_SYNC_CLI', join(homedir(), 'deepseek-harness', 'apps', 'cli', 'lib', 'bin.js')),
    profile: env('DSH_SYNC_TASK_PROFILE', 'headless'),
    /** 以哪个用户身份运行（需与 service 的 User 一致，否则 HOME 会错位）。 */
    home: env('DSH_SYNC_TASK_HOME', homedir()),
    /** 允许作为工作目录的根（逗号分隔）。 */
    allowedRoots: env('DSH_SYNC_TASK_ROOTS', homedir())
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    /** 单次执行硬超时。 */
    timeoutMs: Number(env('DSH_SYNC_TASK_TIMEOUT_MS', '600000')),
    /** 全局并发与单用户并发上限。 */
    maxConcurrent: Number(env('DSH_SYNC_TASK_CONCURRENCY', '2')),
    maxPerUser: Number(env('DSH_SYNC_TASK_PER_USER', '2')),
    /** 提示词长度与输出体积上限。 */
    maxPromptChars: Number(env('DSH_SYNC_TASK_MAX_PROMPT', '8000')),
    maxOutputBytes: Number(env('DSH_SYNC_TASK_MAX_OUTPUT', '200000')),
    /** 透传给子进程的环境变量（模型凭据等）。 */
    envPassthrough: env('DSH_SYNC_TASK_ENV', 'NEW_API_API_KEY,DEEPSEEK_API_KEY')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
}

export function assertConfig() {
  const problems = []
  if (!config.ingestToken) problems.push('DSH_SYNC_INGEST_TOKEN 未设置（插件推送鉴权密钥）')
  if (config.mailEnabled && !config.smtp.user) problems.push('DSH_SYNC_SMTP_USER 未设置')
  if (config.mailEnabled && !config.smtp.pass) problems.push('DSH_SYNC_SMTP_PASS 未设置')
  return problems
}
