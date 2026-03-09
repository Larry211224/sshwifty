# Sshwifty Web SSH Client

**Sshwifty is a web-based SSH client with integrated SFTP file management**, allowing you to access SSH terminal and transfer files right from your web browser.

> Fork of [nirui/sshwifty](https://github.com/nirui/sshwifty), enhanced by Larry Gao.

![Screenshot](Screenshot.png)

## Fork 增强功能

基于上游 [nirui/sshwifty](https://github.com/nirui/sshwifty) 新增的全部功能：

### SSH 终端体验

- **持久化会话** — SSH 会话在服务端保持存活（12 小时 TTL），浏览器刷新后自动恢复终端历史输出（Ring Buffer 机制）
- **多标签恢复** — 刷新页面时一键恢复所有 SSH 标签页，无闪烁加载过程
- **密码保存** — SSH 密码存储在浏览器 localStorage（XOR 混淆），重连时自动登录
- **SharedKey 持久化** — Web 访问密码记忆 12 小时，刷新页面无需重新输入
- **无限回滚** — 终端滚动缓冲区扩展至 999,999 行
- **字体调节** — 可调终端字体大小，设置持久化

### SFTP 文件管理

- **文件浏览器** — 树形目录导航，支持文件/文件夹的新建、删除
- **拖拽上传** — 将文件拖入面板即可上传，大文件分块传输
- **AIMD 自适应限速** — 基于 SSH keepalive 延迟探测动态调整上传速率（512 KB/s ~ 10 MB/s），大文件传输不阻塞终端
- **Web Worker 架构** — SFTP 操作在独立 Worker 线程中运行，UI 不卡顿
- **自动重连** — SFTP 断连后指数退避自动重连

### 连接稳定性

- **TCP KeepAlive** — OS 层 30s 间隔探测，防止 NAT/防火墙/负载均衡器静默断连
- **WebSocket Ping/Pong** — 应用层心跳保活，可配置间隔
- **ReadDeadline 数据刷新** — 收到任何客户端数据即延长超时，避免活跃连接被误杀
- **SFTP SSH KeepAlive** — SFTP 独立 SSH 连接每 30s 发送 keepalive，防止远程服务器关闭空闲会话
- **http.Server 超时优化** — 禁用 Go HTTP Server 的绝对超时，避免 WebSocket 升级后连接被底层 deadline 切断

### 部署优化

- **轻量 Docker 部署** — 本地交叉编译 + alpine 最小镜像，服务器构建仅需 ~20 秒（对比原始多阶段构建 10-15 分钟）
- **一键构建脚本** — `build-deploy.sh` 自动检测增量构建，仅在必要时重新编译前端

### UI 与适配

- **自定义配色** — 重新设计的界面色彩方案
- **移动端适配** — 手机/平板响应式布局，触控友好
- **移除 Telnet** — 仅保留 SSH 功能，精简界面

## 快速部署

推荐使用"本地交叉编译 + 轻量 Docker"方式，服务器构建约 20 秒。

### 1. 本地编译

```shell
git clone https://github.com/Larry211224/sshwifty.git
cd sshwifty
npm install
./build-deploy.sh            # 默认 linux/amd64
./build-deploy.sh linux arm64  # ARM 服务器
```

### 2. 部署到服务器

```shell
scp sshwifty-linux-amd64 Dockerfile.deploy docker-compose.yml user@server:/opt/sshwifty/
# 服务器上
cd /opt/sshwifty && docker compose up -d --build
```

### 3. 访问

浏览器打开 `http://your-server:8182`，输入 SharedKey 密码即可。

> 详细的部署配置、反向代理（Caddy/Nginx）、TLS 设置请参考 [docs/deployment.md](docs/deployment.md)。

### 从源码编译（开发）

环境要求：`git`、`node` (v16+)、`npm`、`go` (v1.24+)

```shell
git clone https://github.com/Larry211224/sshwifty.git
cd sshwifty
npm install
npm run build
```

生成 `sshwifty` 可执行文件。运行：

```shell
SSHWIFTY_LISTENINTERFACE='0.0.0.0' \
  SSHWIFTY_LISTENPORT=8182 \
  SSHWIFTY_SHAREDKEY='your-password' \
  ./sshwifty
```

## Configuration

Sshwifty can be configured through either a configuration file or environment variables.

### Configuration file

See `sshwifty.conf.example.json` for a complete example. Key options:

```jsonc
{
  // Web interface access password (empty = public access)
  "SharedKey": "WEB_ACCESS_PASSWORD",

  // Remote dial timeout in seconds
  "DialTimeout": 10,

  // SOCKS5 proxy (optional)
  "Socks5": "localhost:1080",

  // Server configuration
  "Servers": [
    {
      "ListenInterface": "0.0.0.0",
      "ListenPort": 8182,
      "InitialTimeout": 10,
      "ReadTimeout": 120,
      "WriteTimeout": 120,
      "HeartbeatTimeout": 10,
      "TLSCertificateFile": "",
      "TLSCertificateKeyFile": ""
    }
  ],

  // Preset SSH connections
  "Presets": [
    {
      "Title": "My Server",
      "Type": "SSH",
      "Host": "example.com:22",
      "Meta": {
        "User": "username",
        "Authentication": "Password"
      }
    }
  ],

  // Only allow preset connections
  "OnlyAllowPresetRemotes": false
}
```

### Environment variables

```
SSHWIFTY_HOSTNAME          - HTTP Host filter
SSHWIFTY_SHAREDKEY         - Web access password
SSHWIFTY_DIALTIMEOUT       - Dial timeout (seconds)
SSHWIFTY_SOCKS5            - SOCKS5 proxy address
SSHWIFTY_SOCKS5_USER       - SOCKS5 username
SSHWIFTY_SOCKS5_PASSWORD   - SOCKS5 password
SSHWIFTY_LISTENPORT        - Listen port
SSHWIFTY_LISTENINTERFACE   - Listen interface
SSHWIFTY_INITIALTIMEOUT    - Initial timeout (seconds)
SSHWIFTY_READTIMEOUT       - Read timeout (seconds)
SSHWIFTY_WRITETIMEOUT      - Write timeout (seconds)
SSHWIFTY_HEARTBEATTIMEOUT  - Heartbeat interval (seconds)
SSHWIFTY_READDELAY         - Read delay (milliseconds)
SSHWIFTY_WRITEELAY         - Write delay (milliseconds)
SSHWIFTY_TLSCERTIFICATEFILE    - TLS certificate file path
SSHWIFTY_TLSCERTIFICATEKEYFILE - TLS certificate key path
SSHWIFTY_SERVERMESSAGE     - Home page message
SSHWIFTY_PRESETS           - JSON-encoded presets
SSHWIFTY_ONLYALLOWPRESETREMOTES - Only allow presets
```

## SFTP File Manager

The integrated SFTP file manager provides:

- **File Browser**: Navigate remote directories with a tree-style panel
- **Upload**: Drag and drop files onto the file panel, or use the upload button. Large file uploads use chunked transfer with adaptive rate limiting to maintain terminal responsiveness
- **Download**: Click the download button next to any file
- **Directory Operations**: Create new directories, delete files and folders
- **Auto Reconnect**: SFTP connections automatically reconnect on disconnection with exponential backoff

The SFTP panel appears on the right side of the terminal. Drag the resize handle to adjust the panel width.

## Architecture

```
Browser                              Server (Go)
┌─────────────────────┐              ┌──────────────────────┐
│  xterm.js Terminal   │◄──WS #1────►│  SSH Session         │
│                      │             │  (Terminal PTY)       │
│  SFTP Panel (Vue)    │             │                      │
│    └─ Web Worker     │◄──WS #2────►│  SFTP Session        │
│       (sftp.worker)  │             │  (Independent SSH    │
│                      │             │   connection with    │
│                      │             │   adaptive rate      │
│                      │             │   limiting)          │
└─────────────────────┘              └──────────────────────┘
```

- SSH terminal and SFTP use **independent WebSocket channels** and **separate SSH TCP connections** to avoid mutual blocking
- SFTP operations run entirely in a **Web Worker** thread, keeping the main UI thread responsive
- Upload speed is dynamically adjusted using an **AIMD algorithm** based on SSH keepalive latency probes (range: 512 KB/s ~ 10 MB/s)

## FAQ

### Why does the software say "The datetime difference ... is beyond tolerance"?

Sshwifty's wire protocol uses synchronized time for key generation. Ensure both client and server have accurate system clocks (sync with NTP), then reload the page.

### Why do I get "TypeError: Cannot read property 'importKey' of undefined"?

WebCrypt API is required and only available in [Secure Contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts). Set up HTTPS (via reverse proxy or directly) to resolve this.

### Can I serve Sshwifty under a subpath like `https://my.domain/ssh`?

Not officially supported. Sshwifty assets are served under the `/sshwifty` URL prefix, so you could proxy those requests, but this is not recommended.

## Credits

Based on the original [Sshwifty](https://github.com/nirui/sshwifty) by [Ni Rui](https://github.com/nirui). See [Fork 增强功能](#fork-增强功能) for all changes from upstream.

## License

AGPL-3.0. See [LICENSE.md](LICENSE.md) for details.

Third-party dependencies are listed in [DEPENDENCIES.md](DEPENDENCIES.md).
