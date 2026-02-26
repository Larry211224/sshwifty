let idCounter = 0;

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000];
const MAX_RECONNECT_ATTEMPTS = 4;

export class SFTPClient {
  constructor() {
    this.worker = null;
    this.connected = false;
    this._connectResolve = null;
    this._connectReject = null;
    this._pending = new Map();
    this._uploadProgressCallbacks = new Map();
    this._queue = Promise.resolve();
    this._sessionID = null;
    this._reconnecting = false;
    this._reconnectAttempt = 0;
    this._intentionallyClosed = false;
    this._reconnectTimeoutId = null;
  }

  connect(sessionID) {
    this._sessionID = sessionID;
    this._intentionallyClosed = false;
    this._reconnectAttempt = 0;
    return this._doConnect();
  }

  _doConnect() {
    return new Promise((resolve, reject) => {
      this._connectResolve = resolve;
      this._connectReject = reject;

      if (this.worker) {
        this.worker.terminate();
      }

      this.worker = new Worker(new URL("./sftp.worker.js", import.meta.url));

      this.worker.onmessage = (ev) => this._onWorkerMessage(ev.data);
      this.worker.onerror = (err) => {
        if (!this.connected && this._connectReject) {
          const rej = this._connectReject;
          this._connectReject = null;
          this._connectResolve = null;
          rej(new Error("Worker error: " + err.message));
        }
      };

      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      this.worker.postMessage({
        cmd: "connect",
        sessionID: this._sessionID,
        origin: location.host,
        protocol: protocol,
      });
    });
  }

  _tryReconnect() {
    if (
      this._intentionallyClosed ||
      this._reconnecting ||
      !this._sessionID ||
      this._reconnectAttempt >= MAX_RECONNECT_ATTEMPTS
    ) {
      return;
    }

    this._reconnecting = true;
    const delay =
      RECONNECT_DELAYS[
        Math.min(this._reconnectAttempt, RECONNECT_DELAYS.length - 1)
      ];
    this._reconnectAttempt++;

    this._reconnectTimeoutId = setTimeout(() => {
      this._reconnectTimeoutId = null;
      if (this._intentionallyClosed) {
        this._reconnecting = false;
        return;
      }
      this._doConnect()
        .then(() => {
          this._reconnecting = false;
          this._reconnectAttempt = 0;
        })
        .catch(() => {
          this._reconnecting = false;
          this._tryReconnect();
        });
    }, delay);
  }

  _onWorkerMessage(msg) {
    switch (msg.type) {
      case "connected":
        this.connected = true;
        if (this._connectResolve) {
          const res = this._connectResolve;
          this._connectResolve = null;
          this._connectReject = null;
          res();
        }
        break;

      case "connectError":
        this.connected = false;
        if (this._connectReject) {
          const rej = this._connectReject;
          this._connectReject = null;
          this._connectResolve = null;
          rej(new Error(msg.error));
        }
        break;

      case "disconnected":
        this.connected = false;
        this._rejectAllPending("SFTP connection lost");
        this._tryReconnect();
        break;

      case "response": {
        const p = this._pending.get(msg.id);
        if (p) {
          this._pending.delete(msg.id);
          if (msg.error) {
            p.reject(new Error(msg.error));
          } else {
            p.resolve(msg.result);
          }
        }
        break;
      }

      case "uploadProgress": {
        const cb = this._uploadProgressCallbacks.get(msg.id);
        if (cb) {
          cb(msg.pct, msg.speed);
        }
        break;
      }
    }
  }

  _rejectAllPending(reason) {
    for (const [, p] of this._pending) {
      p.reject(new Error(reason));
    }
    this._pending.clear();
    this._uploadProgressCallbacks.clear();
  }

  _nextId() {
    return "req_" + ++idCounter;
  }

  _request(obj) {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error("SFTP client not connected"));
        return;
      }
      const id = this._nextId();
      this._pending.set(id, { resolve, reject });
      this.worker.postMessage({ cmd: "request", id: id, payload: obj });
    });
  }

  _enqueue(fn) {
    const p = this._queue.then(
      () => fn(),
      () => fn(),
    );
    this._queue = p.catch(() => {});
    return p;
  }

  list(path) {
    return this._enqueue(async () => {
      const resp = await this._request({ action: "list", path: path });
      return resp.files || [];
    });
  }

  mkdir(path) {
    return this._enqueue(() => this._request({ action: "mkdir", path: path }));
  }

  delete(path) {
    return this._enqueue(() => this._request({ action: "delete", path: path }));
  }

  rename(oldPath, newPath) {
    return this._enqueue(() =>
      this._request({ action: "rename", old: oldPath, new: newPath }),
    );
  }

  upload(path, file, onProgress) {
    return this._enqueue(() => {
      return new Promise((resolve, reject) => {
        const id = this._nextId();
        let lastProgressUpdate = 0;

        if (onProgress) {
          this._uploadProgressCallbacks.set(id, (pct, speed) => {
            const now = Date.now();
            if (now - lastProgressUpdate < 200 && pct < 100) return;
            lastProgressUpdate = now;
            onProgress(pct, speed);
          });
        }

        this._pending.set(id, {
          resolve: (result) => {
            this._uploadProgressCallbacks.delete(id);
            resolve(result);
          },
          reject: (err) => {
            this._uploadProgressCallbacks.delete(id);
            reject(err);
          },
        });

        file
          .arrayBuffer()
          .then((buf) => {
            this.worker.postMessage(
              {
                cmd: "upload",
                id: id,
                path: path,
                fileData: buf,
                fileSize: file.size,
              },
              [buf],
            );
          })
          .catch((err) => {
            this._pending.delete(id);
            this._uploadProgressCallbacks.delete(id);
            reject(new Error("Failed to read file: " + err.message));
          });
      });
    });
  }

  download(path) {
    return this._enqueue(() => {
      return new Promise((resolve, reject) => {
        const id = this._nextId();
        this._pending.set(id, { resolve, reject });
        this.worker.postMessage({ cmd: "download", id: id, path: path });
      });
    });
  }

  close() {
    this._intentionallyClosed = true;
    if (this._reconnectTimeoutId) {
      clearTimeout(this._reconnectTimeoutId);
      this._reconnectTimeoutId = null;
    }
    if (this.worker) {
      this.worker.postMessage({ cmd: "close" });
      this.worker.terminate();
      this.worker = null;
    }
    this.connected = false;
    this._reconnecting = false;
    this._pending.clear();
    this._uploadProgressCallbacks.clear();
  }

  isConnected() {
    return this.connected && this.worker !== null;
  }
}
