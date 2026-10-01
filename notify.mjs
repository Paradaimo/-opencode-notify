import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import { execFileSync } from 'node:child_process';

const CONFIG_FILE = path.join(os.homedir(), '.config', 'opencode', 'notify-github.json');
const API_HOST = 'api.github.com';
const REQ_TIMEOUT_MS = 15000;

function loadConfig() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch {
    try {
      const tpl = {
        owner: '<ваш GitHub-логин>',
        repo: '<имя приватного репозитория-ящика>',
        token: '<токен GitHub (доступ Contents: read/write к ящику)>',
        path: 'events.json',
        maxEvents: 100,
      };
      fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(tpl, null, 2), 'utf8');
      console.error('[notify] нет ' + CONFIG_FILE + ' — создан шаблон. Заполните owner/repo/token и перезапустите opencode.');
    } catch { /* ignore */ }
    return null;
  }
  try {
    const c = JSON.parse(raw);
    if (!c.owner || !c.repo || !c.token || /</.test(c.owner + c.repo + c.token)) return null;
    return c;
  } catch {
    return null;
  }
}

function ghRequest(cfg, method, apiPath, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      host: API_HOST,
      path: apiPath,
      method,
      headers: {
        'User-Agent': 'opencode-notify',
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + cfg.token,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
      timeout: REQ_TIMEOUT_MS,
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: b, json });
      });
    });
    req.on('error', (e) => resolve({ status: 0, body: String(e.message || e) }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    if (data) req.end(data); else req.end();
  });
}

let warned = false;
function warnOnce(msg) {
  if (!warned) {
    warned = true;
    console.error('[notify]', msg);
  }
}

const DEBUG_LOG = path.join(os.homedir(), '.config', 'opencode', 'notify-debug.log');
function dbg(msg) {
  try {
    fs.appendFileSync(DEBUG_LOG, new Date().toISOString() + ' ' + msg + '\n');
  } catch { /* ignore */ }
}
function shape(v, depth = 0) {
  try {
    if (v === null || v === undefined) return String(v);
    const t = typeof v;
    if (t !== 'object') return JSON.stringify(v)?.slice(0, 60) ?? String(v);
    if (Array.isArray(v)) return '[' + v.length + ']';
    const keys = Object.keys(v);
    return '{' + keys.slice(0, 12).map((k) => k + ':' + shape(v[k], depth + 1)).join(',') + '}';
  } catch {
    return '?';
  }
}

function curlReq(method, apiPath, token, body) {
  const args = [
    '-s', '--max-time', '20', '-X', method,
    '-H', 'User-Agent: opencode-notify',
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'X-GitHub-Api-Version: 2022-11-28',
    '-H', 'Authorization: Bearer ' + token,
    '-w', '\n%{http_code}',
    'https://' + API_HOST + apiPath,
  ];
  if (body) {
    args.push('-H', 'Content-Type: application/json');
    args.push('--data', JSON.stringify(body));
  }
  try {
    const out = execFileSync('curl', args, { encoding: 'utf8', timeout: 25000 });
    const i = out.lastIndexOf('\n');
    return { status: parseInt(out.slice(i + 1), 10) || 0, body: out.slice(0, i) };
  } catch (e) {
    const out = e.stdout ? String(e.stdout) : '';
    const i = out.lastIndexOf('\n');
    return { status: 0, body: out.slice(0, i) };
  }
}

function readEvents(cfg, apiPath, r) {
  let events = [];
  let sha = null;
  if (r.status === 200 && r.body) {
    try {
      const j = JSON.parse(r.body);
      sha = j.sha;
      events = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
    } catch {
      events = [];
    }
  } else if (r.status !== 404) {
    return null;
  }
  return { events, sha };
}

function buildPutBody(cfg, events, ev, replaceLast) {
  const last = events.length ? events[events.length - 1] : null;
  if (last && last.type === ev.type && last.title === ev.title && last.agent === ev.agent
      && last.dir === ev.dir && last.host === os.hostname()) {
    if (replaceLast) {
      const all = events.slice(0, -1).concat(Object.assign({}, last, { t: new Date().toISOString() }));
      return {
        message: 'opencode retry touch ' + last.seq,
        content: Buffer.from(JSON.stringify(all), 'utf8').toString('base64'),
        encoding: 'base64',
      };
    }
    const tLast = Date.parse(last.t);
    if (Number.isFinite(tLast) && Date.now() - tLast < 10000) {
      dbg('dedup: skip (duplicate of seq ' + last.seq + ')');
      return null;
    }
  }
  const lastSeq = events.length ? events[events.length - 1].seq : 0;
  const seq = lastSeq + 1;
  const data = { seq, t: new Date().toISOString(), host: os.hostname(), type: ev.type, text: ev.text };
  if (ev.title) data.title = ev.title;
  if (ev.agent) data.agent = ev.agent;
  if (ev.dir) data.dir = ev.dir;
  const all = [...events, data];
  if (all.length > (cfg.maxEvents || 100)) all.splice(0, all.length - (cfg.maxEvents || 100));
  return {
    message: 'opencode event ' + seq,
    content: Buffer.from(JSON.stringify(all), 'utf8').toString('base64'),
    encoding: 'base64',
  };
}

function syncSend(job) {
  const cfg = job.cfg;
  const apiPath = '/repos/' + cfg.owner + '/' + cfg.repo + '/contents/' + (cfg.path || 'events.json');
  for (let attempt = 1; attempt <= 3; attempt++) {
    const g = curlReq('GET', apiPath, cfg.token, null);
    const cur = g.status === 200 || g.status === 404 ? readEvents(cfg, apiPath, g) : null;
    if (!cur) {
      dbg('syncSend GET failed: ' + g.status);
      return false;
    }
    const body = buildPutBody(cfg, cur.events, job.data, job.replace);
    if (!body) return true;
    if (cur.sha) body.sha = cur.sha;
    const p = curlReq('PUT', apiPath, cfg.token, body);
    dbg('syncSend PUT status=' + p.status + ' attempt=' + attempt);
    if (p.status >= 200 && p.status < 300) return true;
    if (p.status !== 409) return false;
  }
  return false;
}

const pendingWrites = [];

function asyncSend(job) {
  const cfg = job.cfg;
  const apiPath = '/repos/' + cfg.owner + '/' + cfg.repo + '/contents/' + (cfg.path || 'events.json');
  const one = () => ghRequest(cfg, 'GET', apiPath).then((r) => {
    const cur = (r.status === 200 || r.status === 404)
      ? readEvents(cfg, apiPath, { status: r.status, body: r.body })
      : null;
    if (!cur) {
      warnOnce('GitHub GET failed: ' + r.status + ' ' + r.body.slice(0, 200));
      return false;
    }
    const body = buildPutBody(cfg, cur.events, job.data, job.replace);
    if (!body) {
      job.done = true;
      return true;
    }
    if (cur.sha) body.sha = cur.sha;
    return ghRequest(cfg, 'PUT', apiPath, body).then((p) => {
      dbg('GitHub PUT status=' + (p && p.status));
      if (p && p.status >= 200 && p.status < 300) {
        job.done = true;
        return true;
      }
      if (p && p.status === 409) return one();
      warnOnce('GitHub PUT failed: ' + (p ? p.status + ' ' + p.body.slice(0, 200) : 'no response'));
      return false;
    });
  });
  return one().catch((e) => {
    warnOnce('GitHub error: ' + e);
    return false;
  });
}

process.on('exit', () => {
  for (const job of pendingWrites.splice(0)) {
    if (job.done) continue;
    try {
      syncSend(job);
    } catch (e) {
      dbg('syncSend error: ' + e);
    }
  }
});

function sendToGitHub(type, text, title, agent, dir, replaceLast) {
  const cfg = loadConfig();
  dbg('sendToGitHub type=' + type + ' title=' + title + ' agent=' + agent + ' dir=' + dir + ' replace=' + !!replaceLast + ' cfg=' + !!cfg);
  if (!cfg) return;
  const job = { cfg, data: { type, text, title, agent, dir }, replace: !!replaceLast };
  pendingWrites.push(job);
  asyncSend(job).then((ok) => {
    const i = pendingWrites.indexOf(job);
    if (i >= 0) pendingWrites.splice(i, 1);
    if (!ok) dbg('asyncSend failed, queued for exit fallback');
  });
}

let lastSent = {};
const COOLDOWN_MS = 20000;
function shouldNotify(type, title) {
  const key = type + '|' + (title || '');
  const now = Date.now();
  if (lastSent[key] && now - lastSent[key] < COOLDOWN_MS) return false;
  lastSent[key] = now;
  return true;
}

function errText(err) {
  try {
    if (err && typeof err === 'object') {
      if (err.data && typeof err.data.message === 'string') return err.data.message;
      if (typeof err.message === 'string' && err.message) return err.message;
      if (typeof err.name === 'string' && err.name) return err.name;
    }
    return String(err);
  } catch {
    return 'ошибка';
  }
}

export default function notifyPlugin() {
  const sessions = new Map();
  const pending = new Map();
  const retryThrottle = {};
  const RETRY_THROTTLE_MS = 120000;
  dbg('plugin init');

  const titleOf = (sid) => (sid ? sessions.get(sid)?.title : undefined);

  const subTaskOf = (title) => {
    if (!title) return '';
    return String(title).replace(/\s*\(@[A-Za-z0-9_-]+ subagent\)\s*$/, '').trim();
  };

  const recordSub = (child, note) => {
    const parent = child.parentID ? sessions.get(child.parentID) : undefined;
    if (!parent) return;
    const name = child.agent ? '@' + String(child.agent) : '';
    const task = subTaskOf(child.title);
    const entry = [name, task, note].filter(Boolean).join(name && task ? ': ' : ' ');
    if (entry) parent.subs = [...(parent.subs || []), entry].slice(-5);
  };

  const dirShort = (dir) => {
    if (!dir) return '';
    const parts = String(dir).split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  };

  const notify = (type, text, title, agent, dir, replaceLast) => {
    dbg('notify ' + type + ' title=' + title + ' agent=' + agent + ' dir=' + dir);
    if (!shouldNotify(type, title)) return;
    sendToGitHub(type, text, title, agent, dir, replaceLast);
  };

  return {
    'chat.message': async (input, output) => {
      dbg('hook chat.message input=' + shape(input) + ' output=' + shape(output));
      const sid = input?.sessionID ?? output?.sessionID;
      if (!sid) {
        dbg('hook chat.message NO SID');
        return;
      }
      const cur = sessions.get(sid);
      if (cur) cur.lastAt = Date.now();
      else sessions.set(sid, { title: null, lastAt: Date.now() });
    },
    event: async (arg) => {
      dbg('hook event arg=' + shape(arg));
      const event = arg?.event ?? arg;
      const p = event?.properties ?? {};
      dbg('hook event type=' + event?.type + ' props=' + shape(p));
      switch (event?.type) {
        case 'session.created':
        case 'session.updated': {
          const info = p.info;
          if (info && info.id) {
            const cur = sessions.get(info.id) || {};
            sessions.set(info.id, {
              ...cur,
              title: info.title || cur.title,
              parentID: info.parentID,
              agent: info.agent ?? cur.agent,
              directory: info.directory || cur.directory,
            });
          }
          break;
        }
        case 'session.idle': {
          const sid = p.sessionID;
          if (!sid) return;
          const s = sessions.get(sid);
          if (!s) return;
          if (s.parentID) {
            recordSub(s);
            return;
          }
          const title = s.title;
          const agent = (s.subs && s.subs.length ? s.subs.join('; ') : undefined);
          const dir = dirShort(s.directory);
          sessions.delete(sid);
          delete retryThrottle[sid];
          if (pending.has(sid)) return;
          pending.set(sid, true);
          setTimeout(() => pending.delete(sid), 3000);
          notify('done', 'Готово', title, agent, dir);
          break;
        }
        case 'session.error': {
          const s = sessions.get(p.sessionID);
          if (s && s.parentID) {
            recordSub(s, 'ошибка: ' + errText(p.error).slice(0, 120));
            return;
          }
          const agent = s && s.subs && s.subs.length ? s.subs.join('; ') : undefined;
          const dir = s ? dirShort(s.directory) : undefined;
          delete retryThrottle[p.sessionID];
          notify('error', 'Ошибка: ' + errText(p.error).slice(0, 300), titleOf(p.sessionID), agent, dir);
          break;
        }
        case 'session.status': {
          if (p.status && p.status.type === 'retry' && p.sessionID) {
            const s = sessions.get(p.sessionID);
            if (s && s.parentID) return;
            const now = Date.now();
            if (retryThrottle[p.sessionID] && now - retryThrottle[p.sessionID] < RETRY_THROTTLE_MS) return;
            retryThrottle[p.sessionID] = now;
            const agent = s && s.subs && s.subs.length ? s.subs.join('; ') : undefined;
            const dir = s ? dirShort(s.directory) : undefined;
            notify('retry', 'Повтор после сбоя', titleOf(p.sessionID), agent, dir, true);
          }
          break;
        }
        case 'permission.asked': {
          const sid = p.sessionID;
          const s = sid ? sessions.get(sid) : undefined;
          const isSub = !!(s && s.parentID);
          let title = titleOf(sid);
          if (isSub) title = subTaskOf(title);
          const agent = isSub && s.agent ? '@' + String(s.agent) : undefined;
          const dir = s ? dirShort(s.directory) : undefined;
          const name = p.permission ? String(p.permission) : 'доступы';
          const patterns = Array.isArray(p.patterns) && p.patterns.length
            ? ' (' + p.patterns.slice(0, 3).join(', ') + ')'
            : '';
          if (sid) delete retryThrottle[sid];
          notify('perm', 'Нужны доступы: ' + (name + patterns).slice(0, 200), title, agent, dir);
          break;
        }
      }
    },
  };
}
