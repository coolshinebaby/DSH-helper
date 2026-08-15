const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const initSqlJs = require('sql.js');

const DATA_DIR = path.join(os.homedir(), '.cc-switch');
const DB_PATH = path.join(DATA_DIR, 'cc-switch.db');
const LOG_PATH = path.join(DATA_DIR, 'logs', 'cc-switch.log');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const DSH_DIR = path.join(os.homedir(), '.dsh');
const DSH_STORE_DIR = path.join(DSH_DIR, 'storages');
const DSH_SESSIONS_DIR = path.join(DSH_DIR, 'sessions');
const zlib = require('node:zlib');

let SQL;
let usageCache = { updatedAt: 0, values: new Map() };
const USAGE_CACHE_MS = 30000;
const harnessMessageCache = new Map();

function safeJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function rowsFromResult(result) {
  if (!result?.[0]) return [];
  const { columns, values } = result[0];
  return values.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
}

function parseObject(value) {
  if (!value || typeof value !== 'string') return value || {};
  try { return JSON.parse(value); } catch { return {}; }
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  const clean = {};
  for (const [key, item] of Object.entries(value)) {
    if (/key|token|secret|password|auth|credential/i.test(key)) continue;
    clean[key] = redact(item);
  }
  return clean;
}

function firstValue(object, keys) {
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null && object[key] !== '') return object[key];
  }
  return undefined;
}

function normalizeProvider(row, currentIds) {
  const settings = redact(parseObject(firstValue(row, ['settings_config', 'settings', 'config', 'data', 'metadata', 'provider_config'])));
  const merged = { ...settings, ...redact(row) };
  const id = String(firstValue(merged, ['id', 'provider_id', 'uuid']) || firstValue(merged, ['name', 'display_name']) || Math.random());
  const name = String(firstValue(merged, ['name', 'display_name', 'provider_name', 'label']) || '未命名供应商');
  const type = String(firstValue(merged, ['app_type', 'provider_type', 'type', 'category']) || 'codex').toLowerCase();
  return {
    id,
    name,
    type,
    enabled: firstValue(merged, ['enabled', 'is_enabled', 'active']) !== 0,
    current: Boolean(row.is_current) || currentIds.has(id),
    inFailoverQueue: Boolean(row.in_failover_queue),
    sortIndex: Number.isFinite(Number(row.sort_index)) ? Number(row.sort_index) : null,
    failoverPriority: null,
    website: firstValue(merged, ['website_url', 'website', 'homepage']) || null,
    notes: String(firstValue(merged, ['notes', 'note', 'remark']) || ''),
    status: 'unknown',
    severity: 'none',
    balance: null,
    balanceUnit: 'USD',
    balanceSource: null,
    latency: null,
    error: '',
    lastSeen: null
  };
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function extractBaseUrl(settings, website) {
  const config = String(settings.config || '');
  const match = config.match(/base_url\s*=\s*["']([^"']+)["']/i);
  return (match?.[1] || website || '').replace(/\/+$/, '');
}

function createUsageQuery(row) {
  const settings = parseObject(row.settings_config);
  const meta = parseObject(row.meta);
  const script = meta.usage_script;
  const apiKey = settings.auth?.OPENAI_API_KEY || settings.auth?.ANTHROPIC_API_KEY || settings.auth?.GEMINI_API_KEY;
  if (!script?.enabled || !apiKey || !String(script.code || '').includes('/v1/usage')) return null;
  const baseUrl = extractBaseUrl(settings, row.website_url);
  if (!baseUrl) return null;
  try {
    const url = new URL(`${baseUrl}/v1/usage`);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return { url: url.toString(), apiKey: String(apiKey), timeout: Math.min(15, Math.max(3, Number(script.timeout) || 10)) };
  } catch {
    return null;
  }
}

async function queryUsage(query, fetcher = fetch) {
  if (!query) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), query.timeout * 1000);
  try {
    const response = await fetcher(query.url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${query.apiKey}`, Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal
    });
    if (!response.ok) return null;
    const body = await response.json();
    const remaining = firstValue(body, ['remaining', 'balance']) ?? firstValue(body.quota || {}, ['remaining', 'balance']);
    const numeric = Number(remaining);
    if (!Number.isFinite(numeric)) return null;
    return { balance: numeric, unit: String(firstValue(body, ['unit']) ?? firstValue(body.quota || {}, ['unit']) ?? 'USD') };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function readProvidersFromDatabase() {
  if (!fs.existsSync(DB_PATH)) return [];
  const bytes = fs.readFileSync(DB_PATH);
  const db = new SQL.Database(bytes);
  const tableRows = rowsFromResult(db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"));
  const tables = new Set(tableRows.map((row) => row.name));
  const providers = [];
  const settings = safeJson(SETTINGS_PATH);
  const currentIds = new Set(Object.entries(settings).filter(([key]) => /^currentProvider/i.test(key)).map(([, value]) => String(value)));

  if (tables.has('providers')) {
    const rows = rowsFromResult(db.exec('SELECT id, app_type, name, settings_config, meta, website_url, notes, category, is_current, in_failover_queue, sort_index, limit_daily_usd, limit_monthly_usd, provider_type FROM providers ORDER BY sort_index, name'));
    for (const row of rows) {
      const provider = normalizeProvider(row, currentIds);
      provider.usageQuery = createUsageQuery(row);
      const id = sqlLiteral(provider.id);
      const appType = sqlLiteral(provider.type);

      if (tables.has('provider_health')) {
        const health = rowsFromResult(db.exec(`SELECT is_healthy, consecutive_failures, last_success_at, last_failure_at, last_error, updated_at FROM provider_health WHERE provider_id=${id} AND app_type=${appType} LIMIT 1`))[0];
        if (health) {
          provider.status = health.is_healthy ? 'operational' : Number(health.consecutive_failures) >= 3 ? 'outage' : 'degraded';
          provider.severity = health.is_healthy ? 'none' : Number(health.consecutive_failures) >= 3 ? 'critical' : 'high';
          provider.error = health.last_error || '';
          provider.lastSeen = health.updated_at || health.last_failure_at || health.last_success_at;
        }
      }

      if (tables.has('proxy_request_logs')) {
        const latest = rowsFromResult(db.exec(`SELECT latency_ms, status_code, error_message, created_at FROM proxy_request_logs WHERE provider_id=${id} AND app_type=${appType} ORDER BY created_at DESC LIMIT 1`))[0];
        if (latest) {
          provider.latency = latest.latency_ms == null ? null : Math.round(Number(latest.latency_ms));
          provider.lastSeen ||= latest.created_at;
          if (Number(latest.status_code) >= 400) provider.error ||= `HTTP ${latest.status_code}${latest.error_message ? ` · ${latest.error_message}` : ''}`;
          if (provider.status === 'unknown') {
            provider.status = Number(latest.status_code) >= 500 ? 'degraded' : Number(latest.status_code) >= 400 ? 'outage' : 'operational';
            provider.severity = provider.status === 'operational' ? 'none' : provider.status === 'outage' ? 'critical' : 'high';
          }
        }
      }

      if (tables.has('usage_daily_rollups')) {
        const usage = rowsFromResult(db.exec(`SELECT COALESCE(SUM(total_cost_usd), 0) AS spent FROM usage_daily_rollups WHERE provider_id=${id} AND app_type=${appType} AND date=date('now','localtime')`))[0];
        const dailyLimit = Number(row.limit_daily_usd);
        if (dailyLimit > 0) {
          provider.balance = Math.max(0, dailyLimit - Number(usage?.spent || 0));
          provider.balanceSource = 'dailyLimit';
        }
      }

      if (provider.status === 'unknown') {
        provider.status = 'operational';
        provider.severity = 'none';
      }
      providers.push(provider);
    }
  }

  const queueByType = new Map();
  for (const provider of providers.filter((item) => item.inFailoverQueue)) {
    if (!queueByType.has(provider.type)) queueByType.set(provider.type, []);
    queueByType.get(provider.type).push(provider);
  }
  for (const queue of queueByType.values()) {
    queue.sort((a, b) => (a.sortIndex ?? Infinity) - (b.sortIndex ?? Infinity) || a.name.localeCompare(b.name));
    queue.forEach((provider, index) => { provider.failoverPriority = index + 1; });
  }

  db.close();
  return providers;
}

function decodeLog(buffer) {
  const utf8 = buffer.toString('utf8');
  return utf8.includes('\uFFFD') ? buffer.toString('latin1') : utf8;
}

function readRecentLog() {
  if (!fs.existsSync(LOG_PATH)) return '';
  const stat = fs.statSync(LOG_PATH);
  const size = Math.min(stat.size, 1024 * 1024);
  const fd = fs.openSync(LOG_PATH, 'r');
  const buffer = Buffer.alloc(size);
  fs.readSync(fd, buffer, 0, size, stat.size - size);
  fs.closeSync(fd);
  return decodeLog(buffer);
}

function parseLogSignals(text) {
  const signals = new Map();
  const lines = text.split(/\r?\n/).slice(-3000);
  for (const line of lines) {
    const match = line.match(/^\[([^\]]+)\]\[([^\]]+)\].*?Provider\s+(.+?)\s+(?:失败|澶辫触|failed|error)/i);
    if (!match) continue;
    const [, time, level, rawName] = match;
    const name = rawName.trim().replace(/[：:].*$/, '').slice(0, 80);
    let balance = null;
    const balanceMatch = line.match(/(?:余额|剩余|棰濆害|remaining)[^$¥￥\d-]*[$¥￥]?\s*(-?\d+(?:\.\d+)?)/i);
    if (balanceMatch) balance = Number(balanceMatch[1]);
    const codeMatch = line.match(/HTTP\s+(\d{3})/i);
    signals.set(name.toLowerCase(), {
      name,
      level,
      time,
      balance,
      code: codeMatch?.[1] || '',
      line
    });
  }
  return signals;
}

function applySignals(providers, signals) {
  const now = Date.now();
  for (const provider of providers) {
    const key = provider.name.toLowerCase();
    const signal = signals.get(key) || [...signals.entries()].find(([name]) => name.includes(key) || key.includes(name))?.[1];
    if (!signal) {
      provider.status = provider.enabled ? 'operational' : 'disabled';
      provider.severity = provider.enabled ? 'none' : 'low';
      continue;
    }
    const parsed = Date.parse(signal.time.replace(' ', 'T'));
    const ageMinutes = Number.isFinite(parsed) ? (now - parsed) / 60000 : 0;
    provider.lastSeen = signal.time;
    if (signal.balance !== null) {
      provider.balance = signal.balance;
      provider.balanceUnit = 'USD';
      provider.balanceSource = 'errorLog';
    }
    provider.error = signal.code ? `HTTP ${signal.code}` : '最近请求失败';
    if (signal.code === '401' || signal.code === '403' || signal.balance !== null && signal.balance <= 0) {
      provider.status = 'outage';
      provider.severity = 'critical';
    } else if (signal.code === '429' || signal.code === '503') {
      provider.status = ageMinutes < 30 ? 'degraded' : 'unknown';
      provider.severity = ageMinutes < 30 ? 'high' : 'medium';
    } else {
      provider.status = 'degraded';
      provider.severity = 'medium';
    }
  }

  if (providers.length === 0) {
    for (const signal of signals.values()) {
      providers.push({
        id: `log-${signal.name}`,
        name: signal.name,
        type: 'codex', enabled: true, current: false,
        status: signal.code === '401' || signal.code === '403' ? 'outage' : 'degraded',
        severity: signal.code === '401' || signal.code === '403' ? 'critical' : 'high',
        balance: signal.balance, latency: null,
        error: signal.code ? `HTTP ${signal.code}` : '最近请求失败',
        lastSeen: signal.time
      });
    }
  }
}

function demoProviders() {
  return [
    { id: 'demo-1', name: '示例 · 快速通道', type: 'codex', enabled: true, current: true, status: 'outage', severity: 'critical', balance: 0.11, latency: 1280, error: 'HTTP 403 · 额度不足', lastSeen: new Date().toISOString() },
    { id: 'demo-2', name: '示例 · 主力节点', type: 'claude', enabled: true, current: false, status: 'degraded', severity: 'high', balance: 12.8, latency: 864, error: 'HTTP 429 · 请求频繁', lastSeen: new Date().toISOString() },
    { id: 'demo-3', name: '示例 · 备用节点', type: 'gemini', enabled: true, current: false, status: 'operational', severity: 'none', balance: 78.4, latency: 312, error: '', lastSeen: new Date().toISOString() }
  ];
}

function sortProviders(providers) {
  const statusRank = { outage: 0, degraded: 1, unknown: 2, disabled: 3, operational: 4 };
  const severityRank = { critical: 0, high: 1, medium: 2, low: 3, none: 4 };
  return providers.sort((a, b) =>
    (a.failoverPriority ?? Infinity) - (b.failoverPriority ?? Infinity) ||
    statusRank[a.status] - statusRank[b.status] ||
    severityRank[a.severity] - severityRank[b.severity] ||
    (a.balance ?? Infinity) - (b.balance ?? Infinity) ||
    a.name.localeCompare(b.name, 'zh-CN')
  );
}

function readHarnessMessages(file) {
  if (!file) return [];
  try {
    const stat = fs.statSync(file); const stamp = `${stat.mtimeMs}:${stat.size}`;
    if (harnessMessageCache.get(file)?.stamp === stamp) return harnessMessageCache.get(file).messages;
    const messages = [];
    const raw = zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8');
    for (const line of raw.split(/\r?\n/)) { let event; try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'user/message') { const text = (event.data?.content || []).map((b) => b?.text || '').filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(); if (text) messages.push({ role: '你', text }); }
      if (event.type === 'assistant/message') { const text = (event.data?.message?.content || []).map((b) => b?.text || (b?.type === 'tool-call' ? `[${b.name || '工具调用'}]` : '')).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(); if (text) messages.push({ role: '助手', text }); }
    }
    const result = messages.slice(-3); harnessMessageCache.set(file, { stamp, messages: result }); return result;
  } catch { return []; }
}
function readHarnessSnapshot() {
  const workspace = safeJson(path.join(DSH_STORE_DIR, 'workspace.json'));
  const archived = new Set(workspace.global?.archivedSessionIds || []);
  const cache = safeJson(path.join(DSH_STORE_DIR, 'session_projcache.json')).tables?.sessions || {};
  const logFiles = new Map();
  function walk(dir) { try { for (const item of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, item.name); if (item.isDirectory()) walk(full); else if (item.name === 'session.jsonl.zstd') logFiles.set(path.basename(path.dirname(full)), full); } } catch {} }
  walk(DSH_SESSIONS_DIR);
  const ids = new Set(); for (const ws of Object.values(workspace.tables?.workspaces || {})) for (const id of ws.sessionIds || []) ids.add(id);
  const sessions = [...ids].filter((id) => !archived.has(id)).map((id) => { const entry = cache[id] || {}; const rows = entry.rows || {}; const stats = rows.sessionStats?.val || {}; const raw = rows.tokenUsage?.val || {}; const usage = raw.totals || raw; const input = Number(usage.uncachedInputTokens || 0) + Number(usage.cacheReadTokens || 0) + Number(usage.cacheWriteTokens || 0); let completedAt = null; try { completedAt = fs.statSync(logFiles.get(id)).mtimeMs; } catch {} return { id, title: typeof rows.title?.val === 'string' ? rows.title.val : id, running: Boolean(stats.openStep) || Object.keys(stats.pendingCalls || {}).length > 0, completedAt, stats, usage, input, cacheHit: input ? Math.round(Number(usage.cacheReadTokens || 0) / input * 100) : null, messages: readHarnessMessages(logFiles.get(id)) }; }).sort((a, b) => Number(b.running) - Number(a.running) || a.title.localeCompare(b.title, 'zh-CN'));
  return { sessions, updatedAt: Date.now() };
}

async function getSnapshot(options = {}) {
  SQL ||= await initSqlJs({ locateFile: (file) => require.resolve(`sql.js/dist/${file}`) });
  let providers = [];
  let warning = '';
  try { providers = readProvidersFromDatabase(); } catch (error) { warning = `数据库暂不可读：${error.message}`; }
  const refreshUsage = options.forceUsage || Date.now() - usageCache.updatedAt >= USAGE_CACHE_MS;
  if (refreshUsage) {
    const usageResults = await Promise.all(providers.map((provider) => queryUsage(provider.usageQuery, options.fetcher)));
    const values = new Map();
    providers.forEach((provider, index) => { if (usageResults[index]) values.set(provider.id, usageResults[index]); });
    usageCache = { updatedAt: Date.now(), values };
  }
  providers.forEach((provider) => {
    const usage = usageCache.values.get(provider.id);
    delete provider.usageQuery;
    if (usage) {
      provider.balance = usage.balance;
      provider.balanceUnit = usage.unit;
      provider.balanceSource = 'providerApi';
    }
  });
  const log = readRecentLog();
  const signals = parseLogSignals(log);
  applySignals(providers, signals);
  const isDemo = providers.length === 0;
  if (isDemo) providers = demoProviders();
  return {
    providers: sortProviders(providers),
    mode: isDemo ? 'demo' : 'live',
    warning: warning || (isDemo ? '未发现可识别的 CCSwitch 供应商，当前显示演示数据' : ''),
    source: fs.existsSync(DB_PATH) ? '~/.cc-switch/cc-switch.db' : null,
    updatedAt: new Date().toISOString(),
    harness: readHarnessSnapshot()
  };
}

module.exports = { getSnapshot };
