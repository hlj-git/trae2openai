// 凭证管理：自动探测本机 Trae 安装、解密 storage.json、过期重读
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { decryptStorageValue } = require('./decrypt');

// edition: 目录名, region: cn|sg
const EDITIONS = [
  { dir: 'TRAE SOLO CN', region: 'cn' },   // Trae Work (SOLO) 国内版 —— 首选
  { dir: 'TRAE WORK',    region: 'cn' },
  { dir: 'TRAE SOLO',    region: 'sg' },
  { dir: 'Trae CN',      region: 'cn' },
  { dir: 'Trae',         region: 'sg' },
];

const BASE_URLS = {
  cn: 'https://trae-api-cn.mchost.guru',
  sg: 'https://a0ai-api-sg.byteintlapi.com',
};

const AUTH_KEY = 'iCubeAuthInfo://icube.cloudide';

// 候选 %APPDATA% 根目录（Windows 原生 / WSL2 / macOS）
function candidateRoamingDirs() {
  const dirs = [];
  if (process.env.APPDATA) dirs.push(process.env.APPDATA);
  if (process.platform === 'win32' && process.env.TRAE_WORK_APPDATA) dirs.push(process.env.TRAE_WORK_APPDATA);
  // WSL2: /mnt/c/Users/<name>/AppData/Roaming
  try {
    if (fs.existsSync('/mnt/c')) {
      for (const u of fs.readdirSync('/mnt/c/Users')) {
        if (['Public', 'Default', 'Default User', 'All Users', 'desktop.ini'].includes(u)) continue;
        const d = `/mnt/c/Users/${u}/AppData/Roaming`;
        if (fs.existsSync(d)) dirs.push(d);
      }
    }
  } catch { /* ignore */ }
  if (process.platform === 'darwin') {
    dirs.push(path.join(os.homedir(), 'Library/Application Support'));
  }
  return [...new Set(dirs)];
}

function readStorage(roamingDir, editionDir) {
  const p = path.join(roamingDir, editionDir, 'User', 'globalStorage', 'storage.json');
  try { return { path: p, json: JSON.parse(fs.readFileSync(p, 'utf8')) }; } catch { return null; }
}

function parseAuthValue(v) {
  if (typeof v !== 'string' || !v) return null;
  if (v.trimStart().startsWith('{')) { // SG 版明文
    try { return JSON.parse(v); } catch { return null; }
  }
  const dec = decryptStorageValue(v); // CN 版 tc 加密
  if (!dec) return null;
  try { return JSON.parse(dec); } catch { return null; }
}

class AuthManager {
  constructor(cfg) {
    this.cfg = cfg || {};
    this.cred = null;      // { token, refreshToken, userId, expiredAt, edition, region, storagePath }
    this.reloadPromise = null;
  }

  // 探测所有可用凭证，选择最合适的一个（优先配置的 edition，其次未过期的、expiredAt 最晚的）
  detect() {
    const wanted = (this.cfg.edition || 'auto').toLowerCase();
    const found = [];
    for (const roaming of candidateRoamingDirs()) {
      for (const e of EDITIONS) {
        const st = readStorage(roaming, e.dir);
        if (!st) continue;
        const parsed = parseAuthValue(st.json[AUTH_KEY]);
        if (!parsed || !parsed.token) continue;
        found.push({
          token: parsed.token,
          refreshToken: parsed.refreshToken || '',
          userId: parsed.userId,
          expiredAt: parsed.expiredAt || null,
          edition: e.dir,
          region: e.region,
          storagePath: st.path,
          manual: false,
        });
      }
    }
    if (this.cfg.manualToken) {
      found.push({
        token: this.cfg.manualToken,
        refreshToken: '',
        userId: this.cfg.manualUserId || '',
        expiredAt: null,
        edition: 'manual-token',
        region: 'cn',
        storagePath: null,
        manual: true,
      });
    }
    if (!found.length) return null;

    let pool = found;
    if (wanted !== 'auto') pool = found.filter(f => f.edition.toLowerCase() === wanted);
    if (!pool.length) pool = found;

    const now = Date.now();
    const fresh = pool.filter(f => !f.expiredAt || new Date(f.expiredAt).getTime() > now + 60_000);
    if (fresh.length) {
      fresh.sort((a, b) => new Date(b.expiredAt || 0) - new Date(a.expiredAt || 0));
      return fresh[0];
    }
    // 全部过期：取最晚过期的（IDE 打开时通常已续期落盘，重新读有机会拿到新的）
    pool.sort((a, b) => new Date(b.expiredAt || 0) - new Date(a.expiredAt || 0));
    return pool[0];
  }

  // 获取凭证；已过期则重读一次 storage.json（Trae 运行时会自动续期写回）
  async get(forceReload = false) {
    const expired = this.cred && this.cred.expiredAt &&
      new Date(this.cred.expiredAt).getTime() <= Date.now() + 60_000;
    if (this.cred && !forceReload && !expired) return this.cred;
    if (!this.reloadPromise) {
      this.reloadPromise = (async () => {
        const det = this.detect();
        if (!det) {
          if (!this.cred) {
            throw new Error('未找到 Trae 登录凭证。请先安装并登录 Trae / Trae Work（TRAE SOLO），或配置 manual_token。');
          }
          return this.cred; // 探测失败时沿用旧凭证
        }
        this.cred = det;
        return det;
      })().finally(() => { this.reloadPromise = null; });
    }
    return this.reloadPromise;
  }

  regionBase() {
    if (this.cfg.baseUrl) return this.cfg.baseUrl.replace(/\/+$/, '');
    return BASE_URLS[this.cred?.region || 'cn'];
  }
}

module.exports = { AuthManager, BASE_URLS, parseAuthValue };
