# DSH Sync — 多用户会话记录同步与查看服务

把 DeepSeek Harness 的对话记录同步到一个独立的多用户 Web 服务；
新对话开启时自动向多个邮箱发送带**免登录查看链接**的通知；
并支持从网页端发起对话（由本地执行节点运行）。

## 目录结构

```
server/                 云端服务（Node + SQLite，无框架依赖）
  src/config.js         配置加载（全部来自环境变量）
  src/db.js             存储层：用户/会话/事件/通知邮箱/任务/审计
  src/http.js           路由工具、签名 Cookie、限流
  src/mailer.js         邮件发送（nodemailer，支持多收件人）
  src/transcript.js     把 DSH 事件流投影成聊天记录
  src/views.js          服务端渲染页面
  src/index.js          主入口与全部路由
plugin/                 本地 DSH 插件（推送会话事件）
worker/                 本地执行节点（拉取云端任务并跑 headless）
systemd/                systemd 单元模板
dsh-sync.env.example    云端配置模板
dsh-worker.env.example  本地 worker 配置模板
```

依赖只有两个：`better-sqlite3`（存储）与 `nodemailer`（发信），没有 Web 框架。

---

## 一、架构（重要：云端与本地分离）

实际部署时这两个角色**不在同一台机器**：

```
┌─────────────────────── 云端服务器 ───────────────────────┐
│  dsh-sync (Node + SQLite)                         :8090  │
│    · 多用户账号 / 鉴权                                    │
│    · 会话记录存储与展示                                    │
│    · 通知邮箱配置 + 邮件发送 (SMTP)                        │
│    · 管理员后台                                          │
│    · 任务队列（只入队，不执行）                            │
└──────────────────────────────────────────────────────────┘
        ▲                                    ▲
        │ ① 插件推送会话事件                   │ ③ 网页提交任务
        │   POST /api/ingest                  │   （入队）
        │                                    │
┌───────┴──────────── 本地 Linux 服务器 ─────┴─────────────┐
│  DSH (deepseek-harness)                                  │
│    · dsh-sync 插件  → 推送 session/event                 │
│    · dsh-worker     → 主动拉取任务并执行 headless         │
└──────────────────────────────────────────────────────────┘
        │ ②
        └──► ④ worker 轮询取任务 → 跑 dsh → 回报结果
                （云端碰不到本地进程，所以必须由 worker 主动拉）
```

**为什么任务方向是反的**：云端无法 `spawn` 本地进程，所以网页提交的任务
只能进队列，由本地 worker 主动领取。worker 用 `POST /api/worker/tasks/next` 长轮询。

### 各组件位置

| 组件 | 部署位置 | 路径 |
|---|---|---|
| dsh-sync 服务 | **云端** | `/opt/dsh-sync/server` |
| 会话推送插件 | **本地** | `/opt/dsh-sync/plugin` → 各 profile 的 `node_modules` |
| dsh-worker | **本地** | `/opt/dsh-sync/worker/worker.js` |
| SQLite | 云端 | `/opt/dsh-sync/data/dsh-sync.db` |

---

## 二、鉴权机制（四套独立通道）

| 通道 | 凭证 | 用途 | 校验方式 |
|---|---|---|---|
| **网页端** | 邮箱 + 密码 → HMAC 签名 Cookie | 用户登录 | `timingSafeEqual` 常量时间比较 |
| **插件推送** | `Authorization: Bearer <ingest token>` | 上报会话事件 | 共享密钥比对 |
| **Worker** | `Authorization: Bearer <worker token>` | 领取/回报任务 | SHA-256 哈希比对（库里不存明文） |
| **分享链接** | URL 中的 token | 免登录查看单条会话 | 查表 + 有效期 + 撤销位 |

细节：

- **Cookie**：`dsh_sync_session=<userId>.<HMAC>`，HttpOnly + SameSite=Lax，7 天有效；
  签名密钥落盘在 `share.secret`（600）。每次请求都重新查库确认用户仍存在。
- **权限隔离**：所有查询强制按 `owner_id` 过滤；跨用户访问返回 **404**（不用 403，
  避免泄露"这个会话是否存在"）。
- **管理员**：非管理员访问 `/api/admin/*` 与 `/admin` 一律 **404**，同样不暴露后台存在。
- **越权尝试会被审计**：记入 `audit_log`。
- 全站 `noindex,nofollow`。

---

## 三、四个页面的用法

| 页面 | 地址 | 说明 |
|---|---|---|
| 我的会话 | `/` | 会话列表、搜索、统计 |
| 发起对话 | `/chat` | 提交任务、查看执行状态与结果 |
| 通知邮箱 | `/settings/notify` | 增删通知邮箱、单独启用/停用 |
| 管理后台 | `/admin` | 用户/会话/节点/任务/邮件/审计 |

### 通知邮箱优先级

新会话通知的收件人按以下顺序解析，**全都会收到**（不是只取第一个）：

```
1. 推送里显式指定的 notifyTo
2. 该用户在「通知邮箱」页配置的、且已启用的地址（可多个）
3. 用户注册邮箱本身（始终会收到）
4. 全局兜底 DSH_SYNC_NOTIFY_TO
```

即：**注册邮箱 + 所有启用的额外邮箱** 一起收信。
每个收件人在 `mail_log` 里单独记一行，便于排查是谁没收到。

### 管理后台能做什么

- 用户：查看全部用户、会话数、通知邮箱数，**授予/取消管理员**
- 全部会话：跨用户查看并点进任意会话内容（会写审计日志）
- 执行节点：查看 worker 在线状态、最后心跳、来源 IP，可**撤销**
- 任务：所有用户的任务与状态
- 邮件日志：成功/失败与错误原因
- 审计日志：登录、越权尝试、管理员操作

> 首个注册的账号自动成为管理员；不能取消自己的管理员权限（防锁死）。

---

## 四、网页端发起对话

流程：网页提交 → 云端入队 → 本地 worker 领取 → 跑 `dsh --profile headless` → 回报结果。

### 保护措施

| 措施 | 配置项 | 默认 |
|---|---|---|
| 无在线节点时拒绝提交 | — | 返回 503，避免任务永远排队 |
| 单用户未完成任务上限 | `DSH_SYNC_TASK_PER_USER` | 2 |
| 提交频率限制 | 内置 | 30 次 / 10 分钟 |
| 提示词长度上限 | `DSH_SYNC_TASK_MAX_PROMPT` | 8000 字 |
| 执行硬超时 | `DSH_SYNC_WORKER_TIMEOUT_MS` | 900 秒 |
| **工作目录白名单** | `DSH_SYNC_WORKER_ROOTS` | 仅本地指定目录 |
| 环境变量白名单 | `DSH_SYNC_WORKER_ENV` | 只透传模型凭据 |
| 租约 + 崩溃回收 | 内置 | 超时重排，重试 3 次后判失败 |

**工作目录是两层校验**：云端只检查"是否为绝对路径"（尽早挡掉明显非法的请求），
真正决定性的检查在 **worker 侧** —— 只有它知道本机允许哪些根目录。实测 `/etc`、`/root`
都会被 worker 拒绝。

**这不是沙箱**。任务以运行 worker 的用户身份执行，拥有该用户对文件系统的全部权限。
如果要把"发起对话"开放给不完全信任的人，请务必先把
`DSH_SYNC_WORKER_ROOTS` 收紧到专用目录，并考虑用容器或独立低权限账号运行 worker。

---

## 五、部署

### 云端

```bash
# 1. 放置代码
sudo mkdir -p /opt/dsh-sync
sudo cp -r server /opt/dsh-sync/
cd /opt/dsh-sync/server && sudo npm install --omit=dev

# 2. 配置（从模板复制后填真实值）
sudo cp dsh-sync.env.example /opt/dsh-sync/dsh-sync.env
sudo chmod 600 /opt/dsh-sync/dsh-sync.env
sudo vi /opt/dsh-sync/dsh-sync.env

# 3. 装 systemd 单元
sudo cp systemd/dsh-sync.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-sync
```

`dsh-sync.env` 关键项：

```bash
DSH_SYNC_PORT=8090
DSH_SYNC_PUBLIC_URL=https://your-domain.com     # 用于拼接邮件里的链接
DSH_SYNC_INGEST_TOKEN=<随机串>                   # 与本地插件一致
DSH_SYNC_SMTP_HOST=smtp.zoho.com
DSH_SYNC_SMTP_PORT=465
DSH_SYNC_SMTP_USER=you@example.com
DSH_SYNC_SMTP_PASS=<授权码>
DSH_SYNC_SHARE_TTL_DAYS=30
```

### 本地 DSH 机器

```bash
# 1. 装插件
mkdir -p ~/.dsh/profiles/web/node_modules
cp -r /opt/dsh-sync/plugin ~/.dsh/profiles/web/node_modules/dsh-sync-plugin

# 2. 在 ~/.dsh/profiles/web/cordis.patch.yml 里插入（注意 insert 语法）
#    - insert:
#        - name: dsh-sync-plugin
#          config:
#            endpoint: https://your-domain.com/api/ingest
#            token: <与云端一致>
#            ownerEmail: you@example.com

# 3. 注册 worker（在云端执行，拿到 token）
node -e "
const {createHash}=require('node:crypto');
const D=require('/opt/dsh-sync/server/node_modules/better-sqlite3');
const db=new D('/opt/dsh-sync/data/dsh-sync.db');
const t=process.argv[1];
db.prepare('INSERT OR REPLACE INTO workers (id,name,token_hash,created_at,last_seen_at) VALUES (?,?,?,?,?)')
  .run('home-linux','本地节点',createHash('sha256').update(t).digest('hex'),Date.now(),null);
" '<worker-token>'

# 4. 配置并启动 worker
sudo vi /opt/dsh-sync/dsh-worker.env
sudo systemctl enable --now dsh-worker
```

`/opt/dsh-sync/dsh-worker.env`：

```bash
DSH_SYNC_CLOUD=https://your-domain.com
DSH_SYNC_WORKER_ID=home-linux
DSH_SYNC_WORKER_TOKEN=<上一步的 token>
DSH_SYNC_CLI=/home/<user>/deepseek-harness/apps/cli/lib/bin.js
DSH_SYNC_WORKER_ROOTS=/home/<user>
DSH_SYNC_WORKER_TIMEOUT_MS=900000
NEW_API_API_KEY=<模型密钥>
```

### 上线公网必做

1. **上 HTTPS**（Nginx + Let's Encrypt）。ingest token、worker token、登录密码
   目前都是明文传输，纯 HTTP 上公网等于裸奔。
2. **改掉默认 ingest token**，用随机串。
3. 把 SMTP 密码、token 从明文配置移到 systemd `LoadCredential` 或 secrets 管理。
4. 给 `/api/auth/login` 加失败锁定（目前只有频率限制）。

---

## 六、日常运维

```bash
# 状态
systemctl status dsh-sync          # 云端
systemctl status dsh-worker        # 本地

# 日志
journalctl -u dsh-sync -f
journalctl -u dsh-worker -f

# 配置改动后
sudo systemctl restart dsh-sync
```

数据库 schema 会在服务启动时自动迁移（`CREATE TABLE IF NOT EXISTS`），
升级前建议先备份 `/opt/dsh-sync/data`。

---

## 七、踩过的坑

**① 最后一批事件丢失**
插件靠定时器冲刷缓冲，DSH 进程在定时器触发前就退出了，助手回复整条丢失。
修复：额外订阅 **`session/flush`**（持久化屏障，退出前必然触发），在其中 `drain()`。
修复前后事件数 12 → 20。

**② 插件无法激活**
`TypeError: Cannot read properties of undefined (reading 'validate')` ——
Cordis 用 `Config['~standard'].validate()` 校验，普通对象没有该属性，
而 `@deepseek-ai/schemastery` 在 profile 目录下解析不到。
修复：插件内手写最小 Standard Schema 实现，零依赖。

**③ `cordis.patch.yml` 语法**
顶层条目**要么**带 `id`（改现有行），**要么**用 `insert:` 包裹（插新行）。
两者都不是会报 `id is required for non-insert patches`。

**④ 工具调用显示 unknown**
DSH 用连字符 `tool-call`（不是 `tool_call`）；工具结果嵌在 `data.message` 里，
调用 id 字段是 `callId`/`toolCallId`。

**⑤ 构建失败**
`repositoryCommitHash` 需要 `.git`，而传输时被排除 → 设 `DSH_CLIENT_COMMIT_HASH` 绕过。
`better-sqlite3` 需要 `build-essential`。

**⑥ DSH Web UI 不能绑 0.0.0.0**
DSH 刻意拒绝：*"it would expose remote code execution to the network"*。
`webserver` 的 Config 也只接受 `127.0.0.1` / `0.0.0.0` 两个字面量。
**本项目没有绕过该检查**；需要远程访问请自行加带认证的反向代理。

---

## 八、验证记录

全部在真实环境实测（真实模型、真实 SMTP）：

| 项目 | 结果 |
|---|---|
| 会话同步（4 条真实对话） | ✓ 17–30 事件全部到达 |
| 邮件投递 | ✓ 4/4 成功 |
| 幂等（重复推送） | ✓ `inserted:0` 无重复 |
| 跨用户访问会话 | ✓ 404 |
| 伪造 Cookie | ✓ 401 |
| 普通用户访问管理接口 | ✓ 404（不暴露存在性） |
| 匿名访问管理接口 | ✓ 401 |
| 越权提升管理员 | ✓ 被拒 |
| Worker 无 token / 错 token / Cookie 冒充 | ✓ 均 401 |
| 他人读取/取消任务 | ✓ 404 |
| 他人删除通知邮箱 | ✓ 404 |
| 无在线节点时提交任务 | ✓ 503 |
| **网页提交 → worker 执行 → 同步 → 邮件** | ✓ 全链路打通 |
| 任务租约过期回收 | ✓ 自动重排 |
| 重试超上限 | ✓ 判失败（3 次） |
| Worker 拒绝越界 cwd | ✓ `/etc`、`/root` 均被拒 |
| 相对路径 cwd | ✓ 提交时即 400 |

---

## 九、后续可做

- HTTPS + 域名（**上线公网前必做**）
- 登录失败锁定
- 通知规则细化：按工作目录/项目决定收件人
- 邮件支持抄送、模板自定义
- 任务支持中途追加输入（当前是一次性 headless）
- worker 以容器或独立低权限账号运行，收紧文件系统访问
