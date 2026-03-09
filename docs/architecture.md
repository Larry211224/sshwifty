# Sshwifty 架构设计

## 系统总览

Sshwifty 是一个基于 Web 的 SSH 客户端，采用 Go 后端 + Vue 2 前端的架构。浏览器通过 WebSocket 与服务器通信，服务器代理 SSH/SFTP 连接到远程主机。

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Browser                                    │
│                                                                     │
│  ┌─────────────────┐    ┌──────────────┐    ┌────────────────────┐  │
│  │  xterm.js        │    │  Vue 2 UI    │    │  Web Worker        │  │
│  │  Terminal         │    │  (home.vue)  │    │  (sftp.worker.js)  │  │
│  │  Emulator         │    │              │    │                    │  │
│  └────────┬──────────┘    └──────┬───────┘    └─────────┬──────────┘  │
│           │                      │                      │            │
│           │         WS #1        │                      │  WS #2     │
│           │    (AES-GCM 加密)    │                      │ (明文 JSON)│
└───────────┼──────────────────────┼──────────────────────┼────────────┘
            │                      │                      │
            ▼                      ▼                      ▼
┌───────────────────────────────────────────────────────────────────────┐
│                        Go Server (:8182)                              │
│                                                                       │
│  ┌──────────┐  ┌────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ HTTP     │  │ WebSocket  │  │ SFTP         │  │ Persistent     │  │
│  │ Router   │──│ Handler    │  │ WebSocket    │  │ Session Mgr    │  │
│  │          │  │ (socket)   │  │ (sftpSocket) │  │ (Ring Buffer)  │  │
│  └──────────┘  └─────┬──────┘  └──────┬───────┘  └───────┬────────┘  │
│                      │               │                   │           │
│                      ▼               ▼                   │           │
│              ┌───────────────────────────────┐            │           │
│              │     SSH TCP Connection(s)     │◄───────────┘           │
│              │     (golang.org/x/crypto)     │                       │
│              └───────────────┬───────────────┘                       │
└──────────────────────────────┼───────────────────────────────────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │   Remote SSH Server  │
                    │   (sshd :22)         │
                    └──────────────────────┘
```

## 后端架构 (Go)

### 模块结构

```
sshwifty.go                          # 主入口：加载配置 → 启动服务
│
├── application/
│   ├── application.go               # 应用生命周期管理、信号处理
│   ├── plate.go                     # 版本信息
│   │
│   ├── configuration/               # 配置加载（文件 / 环境变量 / 冗余策略）
│   │   ├── loader_file.go           #   JSON 文件加载器
│   │   ├── loader_enviro.go         #   环境变量加载器
│   │   ├── loader_redundant.go      #   冗余（多源优先级）加载器
│   │   ├── config.go                #   配置结构定义
│   │   ├── server.go                #   服务器级配置（端口/超时/TLS）
│   │   └── preset.go                #   预设连接配置
│   │
│   ├── controller/                  # HTTP 路由与请求处理
│   │   ├── controller.go            #   路由分发器（/ → home, /sshwifty/socket → WS）
│   │   ├── socket.go                #   SSH WebSocket 通道（AES-GCM 加密）
│   │   ├── socket_sftp.go           #   SFTP WebSocket 通道（独立 SSH 连接）
│   │   ├── socket_verify.go         #   WebSocket 认证验证
│   │   ├── reconnect.go             #   断线重连 token 验证
│   │   ├── reattach.go              #   持久化会话重新附着
│   │   ├── home.go                  #   首页静态页面
│   │   ├── static.go                #   静态资源服务
│   │   └── static_pages/            #   [生成] webpack 产物嵌入 Go 二进制
│   │
│   ├── commands/                    # SSH 命令实现
│   │   ├── ssh.go                   #   SSH 连接、认证、PTY、数据转发
│   │   ├── sessions.go              #   会话注册中心（Session/Reconnect Token）
│   │   ├── persistent_session.go    #   持久化会话（Ring Buffer + Attach/Detach）
│   │   └── commands.go              #   命令注册
│   │
│   ├── command/                     # 命令框架（协议层）
│   │   ├── handler.go               #   流处理器
│   │   ├── streams.go               #   多路复用流管理
│   │   ├── header.go                #   协议头解析
│   │   ├── hooks.go                 #   连接前钩子
│   │   └── fsm.go                   #   有限状态机
│   │
│   ├── network/                     # 网络拨号
│   │   ├── dial.go                  #   直连拨号
│   │   ├── dial_socks5.go           #   SOCKS5 代理拨号
│   │   └── conn_timeout.go          #   超时连接包装
│   │
│   ├── log/                         # 日志
│   ├── rw/                          # 读写工具（FetchReader 等）
│   └── server/                      # HTTP Server 启动
```

### 路由表

| 路径 | 处理器 | 说明 |
|---|---|---|
| `/` | `home` | 首页（SPA 入口） |
| `/sshwifty/socket` | `socket` | SSH 终端 WebSocket |
| `/sshwifty/socket/verify` | `socketVerification` | SharedKey 认证验证 |
| `/sshwifty/sftp` | `sftpSocket` | SFTP 文件操作 WebSocket |
| `/sshwifty/reconnect` | `reconnectController` | 断线重连 |
| `/sshwifty/session/reattach` | `reattachController` | 持久化会话重新附着 |
| `/sshwifty/assets/*` | 静态文件 | JS/CSS/图片等前端资源 |

## 前端架构 (Vue 2 + Webpack)

### 模块结构

```
ui/
├── app.js                           # 应用入口
├── app.css / common.css             # 全局样式
├── index.html                       # SPA 模板
│
├── home.vue                         # 主界面（标签页管理、会话恢复）
├── auth.vue                         # SharedKey 认证页
├── loading.vue                      # 加载中页面
│
├── commands/                        # SSH 命令处理
│   ├── ssh.js                       #   SSH 命令协议实现（认证、数据收发）
│   ├── commands.js                  #   命令注册与管理
│   ├── credentials.js               #   密码保存（localStorage XOR 编码）
│   ├── presets.js                   #   预设连接管理
│   └── common.js / events.js        #   公共工具
│
├── sftp/                            # SFTP 文件管理器
│   ├── client.js                    #   SFTPClient 类（主线程代理）
│   └── sftp.worker.js               #   Web Worker（WebSocket + 文件传输）
│
├── widgets/                         # UI 组件
│   ├── screen_console.vue           #   终端控制台（xterm.js + SFTP 面板）
│   ├── connector.vue                #   连接对话框（SSH 参数输入）
│   ├── tab_list.vue / tabs.vue      #   标签页管理
│   ├── status.vue                   #   连接状态指示器
│   └── ...                          #   其他组件
│
├── stream/                          # 通信协议层
│   ├── stream.js                    #   WebSocket 流封装
│   ├── streams.js                   #   多路复用管理
│   ├── sender.js / reader.js        #   数据发送/接收
│   ├── header.js                    #   协议头
│   └── subscribe.js                 #   事件订阅
│
├── control/                         # 控制层
│   └── ssh.js                       #   SSH 控制逻辑
│
├── socket.js                        # WebSocket 连接管理
├── crypto.js                        # AES-GCM 加密（与服务端配对）
├── history.js                       # 连接历史
└── xhr.js                           # HTTP 请求工具
```

## 核心机制

### 1. 双 WebSocket 通道

SSH 终端和 SFTP 使用**独立的 WebSocket 连接和独立的 SSH TCP 连接**，互不阻塞：

```
Browser                                   Server
┌──────────┐  WS #1 (Binary, AES-GCM)    ┌──────────┐  SSH TCP #1  ┌────────┐
│ xterm.js │─────────────────────────────►│ socket   │─────────────►│        │
│          │◄─────────────────────────────│          │◄─────────────│ Remote │
└──────────┘                              └──────────┘              │ sshd   │
                                                                    │        │
┌──────────┐  WS #2 (Text JSON + Binary)  ┌──────────┐  SSH TCP #2  │        │
│ Worker   │─────────────────────────────►│ sftp     │─────────────►│        │
│          │◄─────────────────────────────│ Socket   │◄─────────────│        │
└──────────┘                              └──────────┘              └────────┘
```

- **WS #1** (SSH 终端)：使用自定义二进制协议 + AES-GCM 加密，通过 `command.Handler` 进行多路复用流管理
- **WS #2** (SFTP)：使用 JSON 文本消息 + 二进制数据（文件内容），前端运行在 Web Worker 线程中

### 2. 持久化会话（Persistent Session）

SSH 会话在浏览器断开后仍保持活跃（最长 12 小时），实现刷新不丢失：

```
                    首次连接                        浏览器刷新
                    ────────                        ──────────
┌────────┐                                  ┌────────┐
│Browser │── WS ──► PersistentSession       │Browser │── reattach ──►
│        │          ├─ SSH Client            │(new)   │
└────────┘          ├─ Ring Buffer (64KB)    └────────┘
                    ├─ outputCh ◄── pump()         │
                    └─ keepAlive (30s)              │
                                                    ▼
                    浏览器关闭                 PersistentSession
                    ──────────                ├─ Detach() → outputCh=nil
                    PersistentSession         ├─ Attach(newCh)
                    ├─ Detach()               ├─ Replay ring buffer
                    ├─ SSH 连接保持           └─ 继续正常收发
                    ├─ 输出写入 Ring Buffer
                    └─ 等待重连（12h TTL）
```

**关键组件：**
- `RingBuffer` (64KB)：环形缓冲区，持续记录终端输出，重连时回放
- `PersistentSession`：管理 SSH 连接生命周期、Attach/Detach 切换
- `GlobalPersistentSessions`：全局会话注册表，含定时清理（5 分钟间隔）

### 3. SFTP 自适应限速（AIMD 算法）

上传文件时通过 SSH keepalive 延迟探测动态调整速率，避免大文件传输阻塞终端操作：

```
速率
 ▲
 │     ┌───┐
 │    ╱    │    ╱─── 线性增长 (latency < 100ms: +256KB/s)
10M──┤     │   ╱
 │   │     │  ╱
 │   │     ╰─╱──── 乘性衰减 (latency > 300ms: ×2/3)
 │   │       │
512K─┼───────┤
 │   │       │
 └───┴───────┴───────► 时间

探测机制：
  每 2 秒发送 keepalive@openssh.com 请求
  测量 RTT 延迟 → 判断网络拥塞程度 → 调整上传速率

参数：
  最小速率: 512 KB/s
  最大速率: 10 MB/s
  初始速率: 2 MB/s
  低延迟阈值: 100ms (增速)
  高延迟阈值: 300ms (降速)
  控制粒度: 50ms tick, 每 tick 发送 rate/20 字节
```

### 4. 连接保活（多层机制）

为防止连接意外断开，实现了从 OS 层到应用层的多级保活：

| 层级 | 机制 | 间隔 | 代码位置 |
|------|------|------|----------|
| OS/TCP | TCP KeepAlive | 30s | `server/conn.go` Accept() |
| WebSocket | Ping/Pong | HeartbeatTimeout | `controller/socket.go` |
| WebSocket | ReadDeadline 数据刷新 | 每次收到数据 | `controller/socket.go` buildWSFetcher() |
| SSH | SFTP SSH KeepAlive | 30s | `controller/socket_sftp.go` |
| SSH | 持久化会话 KeepAlive | 30s | `command/persistent_session.go` |

HTTP Server 的 `ReadTimeout`/`WriteTimeout` 设为 0（禁用），避免在 WebSocket 升级后仍持有底层连接的绝对 deadline。`ReadHeaderTimeout` 保留用于防御 slowloris 攻击。

- SSH WebSocket：服务端每 `HeartbeatTimeout` 秒发送 Ping，Pong 超时 = Ping 间隔 + 10s
- SFTP WebSocket：双向保活，服务端 Ping (30s) + 客户端 Worker JSON ping (30s)

### 5. 认证流程

```
Browser                              Server
   │                                    │
   │──── WS Connect ───────────────────►│
   │                                    │
   │◄─── Server Nonce ─────────────────│
   │──── Client Nonce ─────────────────►│
   │                                    │
   │     双方基于 SharedKey + UserAgent  │
   │     + 时间戳派生 AES-128 密钥       │
   │     后续通信全部 AES-GCM 加解密     │
   │                                    │
   │──── SSH Connect Request ──────────►│
   │     (host, user, auth method)      │──── SSH Dial ────►
   │                                    │                    Remote
   │◄─── Fingerprint Verify ───────────│◄─── Host Key ─────
   │──── Accept/Reject ───────────────►│
   │                                    │
   │◄─── Credential Request ──────────│
   │──── Password/Key ────────────────►│──── SSH Auth ─────►
   │                                    │
   │◄─── Connect Succeed ─────────────│◄─── Session Open ──
   │     + SessionID + ReconnectToken   │
   │                                    │
   │◄════ Terminal I/O ═══════════════►│◄════ PTY I/O ════►
```

## 构建流程

```
源码                      构建过程                           产物
──────                    ──────────                         ──────
ui/**                     npm run generate
├── *.vue                 ├── webpack --mode production       .tmp/dist/
├── *.js                  │   ├── babel 转译                  ├── app-*.js
├── *.css                 │   ├── vue-loader                  ├── app-*.css
└── sshwifty.svg          │   ├── favicon 生成                ├── *.png/ico
                          │   ├── CSS/JS 压缩                 └── index.html
                          │   └── 图片优化 (sharp)
                          │
                          └── go generate ./...
                              └── 将 .tmp/dist/ 文件           static_pages/
                                  编码为 Go 字节数组            └── static*_generated.go
                                                                    (约 130 个文件)

                          go build
                          ├── 嵌入静态资源                     sshwifty
                          ├── 编译所有 Go 模块                 (单一二进制, ~20MB)
                          └── -ldflags 注入版本号
```

## 技术栈

| 层级 | 技术 | 版本 |
|---|---|---|
| **后端语言** | Go | 1.24+ |
| **SSH 库** | golang.org/x/crypto | v0.47.0 |
| **SFTP 库** | github.com/pkg/sftp | v1.13.10 |
| **WebSocket** | github.com/gorilla/websocket | v1.5.3 |
| **前端框架** | Vue.js | 2.6 |
| **终端模拟** | xterm.js | 6.0 |
| **构建工具** | Webpack | 5.x |
| **容器化** | Docker (Alpine) | - |
