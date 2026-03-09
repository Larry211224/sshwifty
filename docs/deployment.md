# Sshwifty 部署指南

## 快速部署（推荐）

采用"本地交叉编译 + 服务器轻量 Docker"方式，部署构建时间约 20 秒。

### 1. 本地编译

```bash
# 默认编译 linux/amd64
./build-deploy.sh

# 指定目标平台（如 arm64 服务器）
./build-deploy.sh linux arm64
```

脚本会自动检测已有的前端构建产物，只在必要时重新构建。首次运行需要 Node.js 环境来执行 webpack。

### 2. 传输到服务器

将以下文件传到服务器的部署目录：

```bash
scp sshwifty-linux-amd64 Dockerfile.deploy docker-compose.yml user@server:/opt/sshwifty/
```

或者如果已将二进制提交到 Git 仓库：

```bash
# 服务器上
cd /opt/sshwifty
git pull
```

### 3. 启动服务

```bash
cd /opt/sshwifty
docker compose up -d --build
```

首次构建约 20 秒（拉取 alpine 镜像 + 复制二进制），后续重启几乎瞬时。

### 4. 验证

浏览器打开 `http://your-server:8182`，输入 SharedKey 密码即可使用。

## Docker Compose 配置

```yaml
services:
  sshwifty:
    image: sshwifty:dev
    container_name: sshwifty
    build:
      context: ./
      dockerfile: Dockerfile.deploy
    restart: unless-stopped
    environment:
      - SSHWIFTY_SHAREDKEY=your-password        # Web 访问密码
      - SSHWIFTY_LISTENINTERFACE=0.0.0.0
      - SSHWIFTY_LISTENPORT=8182
      - SSHWIFTY_READTIMEOUT=43200               # 12 小时（持久化会话）
      - SSHWIFTY_WRITETIMEOUT=43200
      - SSHWIFTY_HEARTBEATTIMEOUT=60              # WebSocket 保活间隔
    ports:
      - "8182:8182/tcp"
```

### 关键参数说明

| 参数 | 说明 | 推荐值 |
|---|---|---|
| `SSHWIFTY_SHAREDKEY` | Web 界面访问密码，空值则公开访问 | 设置强密码 |
| `SSHWIFTY_READTIMEOUT` | 读超时（秒），影响持久化会话存活时间 | 43200 (12h) |
| `SSHWIFTY_WRITETIMEOUT` | 写超时（秒） | 43200 (12h) |
| `SSHWIFTY_HEARTBEATTIMEOUT` | WebSocket Ping 间隔（秒） | 60 |
| `SSHWIFTY_DIALTIMEOUT` | SSH 连接超时（秒） | 10 |
| `SSHWIFTY_SOCKS5` | SOCKS5 代理地址（可选） | - |

## 使用配置文件

如需更精细的控制（如预设连接），可使用 JSON 配置文件：

```bash
docker run -d \
  --restart unless-stopped \
  -p 8182:8182 \
  -v /path/to/sshwifty.conf.json:/etc/sshwifty.conf.json \
  -e SSHWIFTY_CONFIG=/etc/sshwifty.conf.json \
  sshwifty:dev
```

配置文件示例见 `sshwifty.conf.example.json`。

## HTTPS / TLS 配置

### 方式一：反向代理（推荐）

使用 Nginx / Caddy 等反向代理提供 TLS，Sshwifty 本身跑 HTTP。

#### Caddy（推荐）

```caddy
ssh.example.com {
    reverse_proxy localhost:8182 {
        transport http {
            read_timeout 0
            write_timeout 0
        }
    }
}
```

Caddy 自动处理 WebSocket 升级和 TLS 证书（Let's Encrypt），无需额外配置。`read_timeout 0` / `write_timeout 0` 禁用反向代理超时，让 WebSocket 长连接由 Sshwifty 自身管理。

#### Nginx

```nginx
server {
    listen 443 ssl;
    server_name ssh.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:8182;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

> `proxy_read_timeout` 和 `proxy_send_timeout` 必须设置足够大（建议 ≥ 24h），否则 Nginx 会提前断开 WebSocket。

### 方式二：Sshwifty 直接 TLS

```bash
docker run -d \
  -p 8182:8182 \
  -e SSHWIFTY_DOCKER_TLSCERT="$(cat /path/to/cert.pem)" \
  -e SSHWIFTY_DOCKER_TLSCERTKEY="$(cat /path/to/key.pem)" \
  sshwifty:dev
```

## 完整 Docker 构建（备选）

如果无法在本地交叉编译，可以使用原始的多阶段构建 `Dockerfile`（构建时间 10-15 分钟）：

```bash
# 修改 docker-compose.yml 中的 dockerfile 为 Dockerfile
docker compose up -d --build
```

## 连接稳定性

Sshwifty 内置多层保活机制防止连接意外断开：

| 层级 | 机制 | 间隔 | 作用 |
|------|------|------|------|
| OS 层 | TCP KeepAlive | 30s | 防止 NAT/防火墙/负载均衡器静默断连 |
| 应用层 | WebSocket Ping/Pong | HeartbeatTimeout | 检测 WebSocket 连接存活 |
| 应用层 | WS ReadDeadline 刷新 | 每次收到数据 | 有数据时自动延长超时 |
| SSH 层 | SSH KeepAlive（SFTP 通道） | 30s | 防止远程 SSH 服务器关闭空闲 SFTP 连接 |

如果仍遇到断连，按以下顺序排查：

1. **反向代理超时** — 确保 Caddy 设置了 `read_timeout 0` / `write_timeout 0`，或 Nginx 设置了足够大的 `proxy_read_timeout`
2. **云服务商防火墙** — 部分云服务商（如阿里云安全组）会关闭长时间空闲的 TCP 连接，TCP KeepAlive 可缓解此问题
3. **HeartbeatTimeout** — 适当缩短 `SSHWIFTY_HEARTBEATTIMEOUT`（如 30）可增加心跳频率

## 安全建议

1. **必须设置 SharedKey** — 不设置密码时任何人都可以通过你的服务器连接 SSH
2. **使用 HTTPS** — WebCrypt API（加密通信）仅在 Secure Contexts 下可用
3. **限制监听范围** — 生产环境使用反向代理，Sshwifty 仅监听 `127.0.0.1`
4. **防火墙** — 仅开放反向代理端口（如 443），不直接暴露 8182
