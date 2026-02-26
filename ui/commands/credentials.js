// Sshwifty - Credentials Manager
//
// Copyright (C) 2019-2025 Ni Rui <ranqus@gmail.com>
//
// Manages saved connection credentials in browser localStorage.
// Uses a per-browser random key for XOR obfuscation to prevent
// casual inspection. This is NOT cryptographically secure — localStorage
// is inherently accessible to same-origin scripts.

const STORAGE_KEY = "sshwifty_saved_credentials_v2";
const DEVICE_KEY_STORAGE = "sshwifty_device_key";
const MAX_CREDENTIALS = 50;
const VERIFY_PREFIX = "sshwifty:";

function getDeviceKey() {
  let key = "";

  try {
    key = localStorage.getItem(DEVICE_KEY_STORAGE) || "";
  } catch (e) {
    // ignore
  }

  if (key.length >= 32) {
    return key;
  }

  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  key = Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");

  try {
    localStorage.setItem(DEVICE_KEY_STORAGE, key);
  } catch (e) {
    // ignore — obfuscation will still work for this session
  }

  return key;
}

function obfuscate(text, key) {
  const prefixed = VERIFY_PREFIX + text;
  let result = "";
  for (let i = 0; i < prefixed.length; i++) {
    result += String.fromCharCode(
      prefixed.charCodeAt(i) ^ key.charCodeAt(i % key.length),
    );
  }
  return btoa(result);
}

function deobfuscate(encoded, key) {
  try {
    const text = atob(encoded);
    let result = "";
    for (let i = 0; i < text.length; i++) {
      result += String.fromCharCode(
        text.charCodeAt(i) ^ key.charCodeAt(i % key.length),
      );
    }
    if (!result.startsWith(VERIFY_PREFIX)) {
      return "";
    }
    return result.slice(VERIFY_PREFIX.length);
  } catch (e) {
    return "";
  }
}

export class CredentialsManager {
  constructor() {
    this.deviceKey = getDeviceKey();
    this.credentials = this.load();
    this.cleanupLegacy();
  }

  cleanupLegacy() {
    try {
      localStorage.removeItem("sshwifty_saved_credentials");
    } catch (e) {
      // ignore
    }
  }

  getKey(type, user, host) {
    return type + ":" + user + "@" + host;
  }

  save(type, user, host, password, savePassword) {
    if (!savePassword || !password) {
      this.remove(type, user, host);
      return;
    }

    const key = this.getKey(type, user, host);
    this.credentials[key] = {
      type: type,
      user: user,
      host: host,
      password: obfuscate(password, this.deviceKey),
      savedAt: Date.now(),
    };

    this.enforceLimit();
    this.persist();
  }

  get(type, user, host) {
    const key = this.getKey(type, user, host);
    const cred = this.credentials[key];

    if (!cred || !cred.password) {
      return null;
    }

    const pw = deobfuscate(cred.password, this.deviceKey);
    if (!pw) {
      return null;
    }

    return {
      type: cred.type,
      user: cred.user,
      host: cred.host,
      password: pw,
      savedAt: new Date(cred.savedAt),
    };
  }

  remove(type, user, host) {
    const key = this.getKey(type, user, host);
    delete this.credentials[key];
    this.persist();
  }

  has(type, user, host) {
    return !!this.credentials[this.getKey(type, user, host)];
  }

  clear() {
    this.credentials = {};
    this.persist();
  }

  enforceLimit() {
    const keys = Object.keys(this.credentials);
    if (keys.length <= MAX_CREDENTIALS) {
      return;
    }

    const sorted = keys.sort((a, b) => {
      return (
        (this.credentials[a].savedAt || 0) - (this.credentials[b].savedAt || 0)
      );
    });

    while (Object.keys(this.credentials).length > MAX_CREDENTIALS) {
      delete this.credentials[sorted.shift()];
    }
  }

  load() {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      if (!data) {
        return {};
      }
      const parsed = JSON.parse(data);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        return {};
      }
      return parsed;
    } catch (e) {
      return {};
    }
  }

  persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.credentials));
    } catch (e) {
      // localStorage full or unavailable — silently drop
    }
  }
}

export const credentials = new CredentialsManager();
