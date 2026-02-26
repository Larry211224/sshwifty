let ws = null;
let connected = false;
let pendingResolveId = null;
let downloadChunks = [];
let downloadPendingId = null;
let heartbeat = null;
let uploadInitCallback = null;

function sendToMain(msg) {
  self.postMessage(msg);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeat = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action: "ping" }));
    }
  }, 30000);
}

function stopHeartbeat() {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

function waitForDrain(cb) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount < 512 * 1024) {
    cb();
  } else {
    setTimeout(() => waitForDrain(cb), 5);
  }
}

function handleTextMessage(text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch (_e) {
    return;
  }

  if (pendingResolveId && uploadInitCallback) {
    if (msg.type !== "error") {
      pendingResolveId = null;
      const cb = uploadInitCallback;
      uploadInitCallback = null;
      cb();
    } else {
      const realId = pendingResolveId.replace(/_init$/, "");
      pendingResolveId = null;
      uploadInitCallback = null;
      sendToMain({
        type: "response",
        id: realId,
        error: msg.message,
      });
    }
    return;
  }

  if (!connected) {
    if (msg.type === "success" && msg.message === "connected") {
      connected = true;
      startHeartbeat();
      sendToMain({ type: "connected" });
      return;
    }
    if (msg.type === "error") {
      sendToMain({ type: "connectError", error: msg.message });
      return;
    }
  }

  if (msg.type === "pong" || msg.type === "download_start") {
    return;
  }

  if (msg.type === "download_end" && downloadPendingId !== null) {
    const blob = new Blob(downloadChunks);
    downloadChunks = [];
    const id = downloadPendingId;
    downloadPendingId = null;
    sendToMain({ type: "response", id: id, result: blob });
    return;
  }

  if (msg.type === "error" && downloadPendingId !== null) {
    downloadChunks = [];
    const id = downloadPendingId;
    downloadPendingId = null;
    sendToMain({ type: "response", id: id, error: msg.message });
    return;
  }

  if (pendingResolveId !== null) {
    const id = pendingResolveId;
    pendingResolveId = null;
    if (msg.type === "error") {
      sendToMain({ type: "response", id: id, error: msg.message });
    } else {
      sendToMain({ type: "response", id: id, result: msg });
    }
  }
}

function handleBinaryMessage(data) {
  if (downloadPendingId !== null) {
    downloadChunks.push(data);
  }
}

function doConnect(sessionID, origin, protocol) {
  const url = `${protocol}//${origin}/sshwifty/sftp?session=${sessionID}`;
  ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {};

  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      handleTextMessage(ev.data);
    } else {
      handleBinaryMessage(ev.data);
    }
  };

  ws.onerror = () => {
    if (!connected) {
      sendToMain({
        type: "connectError",
        error: "SFTP WebSocket connection failed",
      });
    }
  };

  ws.onclose = () => {
    const wasConnected = connected;
    connected = false;
    stopHeartbeat();
    if (pendingResolveId !== null) {
      const realId = pendingResolveId.replace(/_init$/, "");
      sendToMain({
        type: "response",
        id: realId,
        error: "SFTP connection closed",
      });
      pendingResolveId = null;
    }
    if (downloadPendingId !== null) {
      sendToMain({
        type: "response",
        id: downloadPendingId,
        error: "SFTP connection closed",
      });
      downloadPendingId = null;
      downloadChunks = [];
    }
    if (wasConnected) {
      sendToMain({ type: "disconnected" });
    }
  };
}

function doRequest(id, obj) {
  pendingResolveId = id;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    pendingResolveId = null;
    sendToMain({ type: "response", id: id, error: "SFTP not connected" });
    return;
  }
  ws.send(JSON.stringify(obj));
}

function doUpload(id, path, fileData, fileSize) {
  pendingResolveId = id + "_init";

  uploadInitCallback = () => {
    stopHeartbeat();
    const chunkSize = 64 * 1024;
    let offset = 0;
    const uploadStart = Date.now();
    let lastSpeedCheck = uploadStart;
    let lastSpeedOffset = 0;
    let currentSpeed = 0;
    let lastPct = -1;

    const reportProgress = () => {
      const now = Date.now();
      const elapsed = now - lastSpeedCheck;
      if (elapsed >= 300) {
        currentSpeed = ((offset - lastSpeedOffset) / elapsed) * 1000;
        lastSpeedCheck = now;
        lastSpeedOffset = offset;
      }
      const pct = Math.min(100, Math.round((offset / fileSize) * 100));
      if (pct !== lastPct) {
        lastPct = pct;
        const reportSpeed =
          currentSpeed > 0
            ? currentSpeed
            : (offset / Math.max(1, Date.now() - uploadStart)) * 1000;
        sendToMain({
          type: "uploadProgress",
          id: id,
          pct: pct,
          speed: reportSpeed,
        });
      }
    };

    const sendChunks = () => {
      let sent = 0;
      while (offset < fileSize && sent < 8) {
        const end = Math.min(offset + chunkSize, fileSize);
        const piece = fileData.slice(offset, end);
        ws.send(piece);
        offset = end;
        sent++;

        if (ws.bufferedAmount > 512 * 1024) {
          reportProgress();
          waitForDrain(sendChunks);
          return;
        }
      }

      reportProgress();

      if (offset < fileSize) {
        setTimeout(sendChunks, 0);
      } else {
        waitForDrain(() => {
          startHeartbeat();
          pendingResolveId = id;
          ws.send(JSON.stringify({ action: "upload_done" }));
        });
      }
    };

    sendChunks();
  };

  ws.send(JSON.stringify({ action: "upload", path: path, size: fileSize }));
}

function doDownload(id, path) {
  downloadChunks = [];
  downloadPendingId = id;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    downloadPendingId = null;
    sendToMain({ type: "response", id: id, error: "SFTP not connected" });
    return;
  }
  ws.send(JSON.stringify({ action: "download", path: path }));
}

function doClose() {
  stopHeartbeat();
  uploadInitCallback = null;
  pendingResolveId = null;
  downloadPendingId = null;
  downloadChunks = [];
  if (ws) {
    ws.close();
    ws = null;
  }
  connected = false;
}

self.onmessage = (ev) => {
  const msg = ev.data;
  switch (msg.cmd) {
    case "connect":
      doConnect(msg.sessionID, msg.origin, msg.protocol);
      break;
    case "request":
      doRequest(msg.id, msg.payload);
      break;
    case "upload":
      doUpload(msg.id, msg.path, msg.fileData, msg.fileSize);
      break;
    case "download":
      doDownload(msg.id, msg.path);
      break;
    case "close":
      doClose();
      break;
  }
};
