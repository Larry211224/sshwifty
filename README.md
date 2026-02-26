# Sshwifty Web SSH Client

**Sshwifty is a web-based SSH client with integrated SFTP file management**, allowing you to access SSH terminal and transfer files right from your web browser.

![Screenshot](Screenshot.png)

## Features

- **SSH Terminal**: Full-featured SSH terminal emulator powered by xterm.js with WebGL rendering support
- **SFTP File Manager**: Built-in file browser with drag-and-drop upload, download, directory creation, and file/folder deletion
- **Adaptive Rate Limiting**: Dynamic SFTP upload speed adjustment based on network latency (AIMD algorithm), ensuring terminal responsiveness during file transfers
- **Web Worker Architecture**: SFTP operations run in a dedicated Web Worker thread, preventing UI freezes during large file transfers
- **Auto Reconnect**: Server-side token-based SSH session reconnection after page refresh (within configurable timeout)
- **Font Size Control**: Adjustable terminal font size with persistent settings
- **Preset Connections**: Pre-configure SSH connections for quick access
- **Secure**: SharedKey authentication for web interface access, WebSocket origin validation

## Install

### Docker Image (recommended)

```shell
$ docker run --detach \
  --restart unless-stopped \
  --publish 8182:8182 \
  --name sshwifty \
  niruix/sshwifty:latest
```

This will open port `8182` on the Docker host. To expose locally only:

```shell
$ docker run --detach \
  --restart unless-stopped \
  --publish 127.0.0.1:8182:8182 \
  --name sshwifty \
  niruix/sshwifty:latest
```

For TLS support:

```shell
$ openssl req \
  -newkey rsa:4096 -nodes -keyout domain.key -x509 -days 90 -out domain.crt
$ docker run --detach \
  --restart always \
  --publish 8182:8182 \
  --env SSHWIFTY_DOCKER_TLSCERT="$(cat domain.crt)" \
  --env SSHWIFTY_DOCKER_TLSCERTKEY="$(cat domain.key)" \
  --name sshwifty \
  niruix/sshwifty:latest
```

### Compile from source code

Requirements:

- `git` to download the source code
- `node` (v16+) and `npm` to build the front-end
- `go` (v1.21+) to build the back-end

Build steps:

```shell
$ git clone https://github.com/Larry211224/sshwifty.git
$ cd sshwifty
$ npm install
$ npm run build
```

The `sshwifty` binary will be generated in the current directory.

To build manually (step by step):

```shell
$ npm install
$ npx webpack --mode production
$ go generate ./...
$ go build -o sshwifty .
```

### Run

Using environment variables:

```shell
$ SSHWIFTY_LISTENINTERFACE='0.0.0.0' \
  SSHWIFTY_LISTENPORT=8182 \
  SSHWIFTY_SHAREDKEY='your-password' \
  ./sshwifty
```

Using a configuration file:

```shell
$ SSHWIFTY_CONFIG=./sshwifty.conf.json ./sshwifty
```

Then open `http://localhost:8182` in your browser.

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

Based on the original [Sshwifty](https://github.com/nirui/sshwifty) by [Ni Rui](https://github.com/nirui).

Enhanced with SFTP support, adaptive rate limiting, auto-reconnect, and other improvements.

## License

AGPL-3.0. See [LICENSE.md](LICENSE.md) for details.

Third-party dependencies are listed in [DEPENDENCIES.md](DEPENDENCIES.md).
