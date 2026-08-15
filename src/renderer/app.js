const state = { snapshot: null, preferences: null, filter: 'all', appType: 'codex', query: '', expanded: null, view: 'provider', remaining: 0, timer: null, refreshing: false, interactionPaused: false, resizePending: false, runningSessionIds: null, endedSessions: new Map() };
const $ = (selector) => document.querySelector(selector);
const statusLabels = { operational: '正常', degraded: '降级', outage: '故障', unknown: '未知', disabled: '停用' };
const severityLabels = { critical: '严重', high: '高', medium: '中', low: '低', none: '正常' };
const statusColors = { operational: '#55d99b', degraded: '#ffb454', outage: '#ff6b70', unknown: '#959ba6', disabled: '#727782' };
const typeLabels = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', grokbuild: 'Grok', opencode: 'OpenCode', openclaw: 'OpenClaw', hermes: 'Hermes' };
const typeOrder = ['claude', 'codex', 'gemini', 'grokbuild', 'opencode', 'openclaw', 'hermes'];

function escapeHtml(value) { const node = document.createElement('div'); node.textContent = value ?? ''; return node.innerHTML; }
function formatBalance(value, unit = 'USD') {
  if (value === null || value === undefined) return '';
  const numeric = Number(value);
  const amount = numeric.toFixed(Math.abs(numeric) < 10 ? 2 : 1);
  if (unit === 'USD') return `$${amount}`;
  if (unit === 'CNY') return `¥${amount}`;
  return `${amount} ${unit}`;
}
function latencyLevel(value) {
  if (!Number.isFinite(Number(value))) return 0;
  if (value <= 500) return 4;
  if (value <= 1500) return 3;
  if (value <= 5000) return 2;
  return 1;
}
function signalTemplate(value) {
  const level = latencyLevel(value);
  return `<span class="latency-signal level-${level}" title="${value ? '延迟信号' : '暂无延迟记录'}"><i></i><i></i><i></i><i></i></span>`;
}
function formatTime(value) {
  if (!value) return '暂无检查记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function counts() {
  const providers = state.snapshot?.providers || [];
  return {
    healthy: providers.filter((p) => p.status === 'operational').length,
    warning: providers.filter((p) => ['degraded', 'unknown', 'disabled'].includes(p.status)).length,
    outage: providers.filter((p) => p.status === 'outage').length
  };
}

function renderSummary() {
  const value = counts();
  $('#healthyCount').textContent = $('#compactHealthy').textContent = value.healthy;
  $('#warningCount').textContent = $('#compactWarning').textContent = value.warning;
  $('#outageCount').textContent = $('#compactOutage').textContent = value.outage;
  const total = value.healthy + value.warning + value.outage;
  $('#allCount').textContent = total;
  document.querySelectorAll('.overview button').forEach((button) => button.classList.toggle('active', button.dataset.filter === state.filter));
  $('#summaryText').textContent = value.outage ? `${value.outage} 个故障 · ${total} 个供应商` : `${value.healthy}/${total} 可用`;
  const current = state.snapshot?.providers?.find((provider) => provider.current);
  const currentColor = statusColors[current?.status] || statusColors.unknown;
  $('#compactProviderCard').style.setProperty('--state', currentColor);
  $('#compactCurrentDot').style.background = currentColor;
  $('#compactCurrentType').textContent = current ? (typeLabels[current.type] || current.type || '') : '';
  $('#compactCurrentName').textContent = current?.name || '未选择供应商';
  $('#compactSeverity').textContent = severityLabels[current?.severity] || '未知';
  $('#compactBalance').textContent = current ? formatBalance(current.balance, current.balanceUnit) : '';
  $('#compactLatency').innerHTML = signalTemplate(current?.latency);
  $('#compactPriority').textContent = current?.failoverPriority ? `P${current.failoverPriority}` : '';
  $('#compactPriority').classList.toggle('hidden', !current?.failoverPriority);
}

function providerTemplate(provider) {
  const open = state.expanded === provider.id;
  const balance = formatBalance(provider.balance, provider.balanceUnit);
  return `<article class="provider ${open ? 'open' : ''}" style="--state:${statusColors[provider.status] || statusColors.unknown}">
    <button class="provider-main" data-provider="${escapeHtml(provider.id)}">
      <span class="provider-name-line"><i class="status-dot"></i>${provider.failoverPriority ? `<span class="priority-badge">P${provider.failoverPriority}</span>` : ''}<span class="provider-name" title="${escapeHtml(provider.name)}">${escapeHtml(provider.name)}</span>${provider.current ? '<span class="current-badge">当前</span>' : ''}</span>
      <span class="severity">${severityLabels[provider.severity] || '未知'}</span>
      <span class="provider-metrics">
        <span class="balance-value">${escapeHtml(balance)}</span>
        <span class="side-metric">${signalTemplate(provider.latency)}</span>
      </span>
    </button>
    <div class="provider-detail"><span>最近状态</span><b>${escapeHtml(provider.error || '未发现异常')}</b><span>检查记录</span><b>${escapeHtml(formatTime(provider.lastSeen))}</b><span>备注</span><b class="notes-value">${escapeHtml(provider.notes || '')}</b><span>通道类型</span><b>${escapeHtml(typeLabels[provider.type] || provider.type || '未知')}</b>${provider.website ? `<span>供应商官网</span><button class="website-link" data-url="${escapeHtml(provider.website)}" title="在默认浏览器中打开">${escapeHtml(provider.website)} ↗</button>` : '<span>供应商官网</span><b></b>'}</div>
  </article>`;
}

function renderTypeTabs() {
  const providers = state.snapshot?.providers || [];
  const countsByType = providers.reduce((counts, provider) => {
    const type = provider.type || 'other';
    counts[type] = (counts[type] || 0) + 1;
    return counts;
  }, {});
  const types = Object.keys(countsByType).sort((a, b) => {
    const aRank = typeOrder.includes(a) ? typeOrder.indexOf(a) : typeOrder.length;
    const bRank = typeOrder.includes(b) ? typeOrder.indexOf(b) : typeOrder.length;
    return aRank - bRank || a.localeCompare(b);
  });
  if (state.appType !== 'all' && !types.includes(state.appType)) state.appType = 'all';
  $('#typeTabs').innerHTML = [`<button class="${state.appType === 'all' ? 'active' : ''}" data-type="all">全部 <b>${providers.length}</b></button>`, ...types.map((type) => `<button class="${state.appType === type ? 'active' : ''}" data-type="${escapeHtml(type)}">${escapeHtml(typeLabels[type] || type)} <b>${countsByType[type]}</b></button>`)].join('');
  document.querySelectorAll('[data-type]').forEach((button) => button.addEventListener('click', () => {
    state.appType = button.dataset.type;
    state.expanded = null;
    renderTypeTabs();
    renderProviders();
  }));
}

function renderProviders() {
  const providers = (state.snapshot?.providers || []).filter((provider) => {
    const matchesQuery = provider.name.toLowerCase().includes(state.query.toLowerCase());
    const matchesFilter = state.filter === 'all' || provider.status === state.filter || state.filter === 'degraded' && ['degraded', 'unknown', 'disabled'].includes(provider.status);
    const matchesType = state.appType === 'all' || provider.type === state.appType;
    return matchesQuery && matchesFilter && matchesType;
  });
  $('#providerList').innerHTML = providers.length ? providers.map(providerTemplate).join('') : '<div class="empty">没有符合条件的供应商</div>';
  document.querySelectorAll('[data-provider]').forEach((button) => button.addEventListener('click', () => {
    const provider = (state.snapshot?.providers || []).find((item) => item.id === button.dataset.provider);
    if (state.expanded === button.dataset.provider) {
      window.monitorAPI.openCCSwitchProvider(provider);
      return;
    }
    state.expanded = button.dataset.provider;
    renderProviders();
  }));
  document.querySelectorAll('.website-link').forEach((button) => button.addEventListener('click', () => window.monitorAPI.openExternal(button.dataset.url)));
}

function formatHarnessTokens(n) { const value = Number(n || 0); if (value < 1000) return String(Math.round(value)); if (value < 1e6) return `${(value / 1e3).toFixed(value < 1e5 ? 1 : 0).replace('.0', '')}K`; return `${(value / 1e6).toFixed(1).replace('.0', '')}M`; }
function formatHarnessDuration(ms) { const seconds = Math.max(0, Math.round(Number(ms || 0) / 1000)); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`; }
function formatElapsed(startTime) { const seconds = Math.max(0, Math.floor((Date.now() - Number(startTime || Date.now())) / 1000)); return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; }
function sessionStatus(session, ended = false) { if (ended || !session.running) return `完成 · ${new Date(session.completedAt || Date.now()).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`; return `进行中 · ${formatElapsed(session.stats?.openStep?.startTime)}`; }
function sessionOutput(session) {
  const assistant = (session.messages || []).filter((message) => message.role === '助手').at(-1);
  return assistant?.text || (session.messages || []).at(-1)?.text || '';
}
function harnessCard(session) { const stats = session.stats || {}; const running = session.running; const cardState = running ? 'running' : 'completed'; const color = running ? '#168a5b' : '#9299a5'; const ttft = Number(stats.ttftMs || 0) / Math.max(Number(stats.ttftSteps || 0), 1); const tps = Math.round(Number(stats.decodeTokens || 0) / Math.max(Number(stats.decodeMs || 0) / 1000, .001)); const output = sessionOutput(session); return `<article class="harness-card ${cardState}" style="--state:${color}"><button data-harness-session="${escapeHtml(session.id)}"><div class="harness-card-top"><i class="harness-dot"></i><strong class="harness-title" title="${escapeHtml(session.title)}">${escapeHtml(session.title)}</strong><span class="harness-badge">${sessionStatus(session)}</span></div><div class="harness-stats compact-stats"><span>${stats.turns || 0} 轮 · ${stats.steps || 0} 步 · LLM ${formatHarnessDuration(stats.llmMs)}</span><span>${tps} tok/s · 输出 ${formatHarnessTokens(session.usage?.outputTokens)} tok · 缓存 ${session.cacheHit ?? 0}%</span></div>${output ? `<p class="harness-output" title="${escapeHtml(output)}">${escapeHtml(output)}</p>` : ''}</button></article>`; }
function compactHarnessCard(session, ended = false) { const stats = session.stats || {}; const color = ended ? '#b66a09' : '#168a5b'; return `<article class="compact-harness-card ${ended ? 'just-ended' : ''}" style="--state:${color}"><button data-harness-session="${escapeHtml(session.id)}"><div class="harness-card-top"><i class="harness-dot"></i><strong class="harness-title" title="${escapeHtml(session.title)}">${escapeHtml(session.title)}</strong><span class="harness-badge">${sessionStatus(session, ended)}</span></div><div class="compact-harness-meta"><span>DeepSeek · ${stats.turns || 0} 轮 · ${stats.steps || 0} 步</span><span>输出 ${formatHarnessTokens(session.usage?.outputTokens)} tok</span></div></button></article>`; }
function orbSessionCard(session, ended, index) {
  const fullTitle = `${(session.title || '').trim() || '未命名任务'}`;
  const preview = sessionOutput(session);
  const startTime = Number(session.stats?.openStep?.startTime);
  const endedAt = session.completedAt ? new Date(session.completedAt) : null;
  const timeLabel = ended
    ? (endedAt ? endedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--:--:--')
    : (startTime ? formatElapsed(startTime) : '00:00');
  const statusText = ended ? `已完成 · ${timeLabel}` : `运行中 · ${timeLabel}`;
  const statusTitle = ended && endedAt ? `完成于 ${endedAt.toLocaleString('zh-CN')}` : '';
  const previewHtml = preview ? `<small class="orb-session-preview" title="${escapeHtml(preview)}">${escapeHtml(truncate(preview, 64))}</small>` : '';
  return `<button class="orb-session-card ${ended ? 'completed' : 'running'}" data-orb-session="${escapeHtml(session.id)}"><span class="orb-session-state"><span class="orb-session-status" title="${escapeHtml(statusTitle)}">${escapeHtml(statusText)}</span><span class="orb-session-index">任务 ${index}</span></span><strong title="${escapeHtml(fullTitle)}">${escapeHtml(truncate(fullTitle, 36))}</strong>${previewHtml}</button>`;
}
function truncate(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}
function bindHarnessLinks() {
  document.querySelectorAll('#harnessList [data-harness-session]').forEach((button) => button.addEventListener('click', () => window.monitorAPI.openExternal('http://127.0.0.1:3080')));
  document.querySelectorAll('#compactHarnessList [data-harness-session]').forEach((button) => button.addEventListener('click', () => showModule('harness')));
  document.querySelectorAll('[data-orb-session]').forEach((button) => button.addEventListener('click', restoreCompact));
}
function renderHarness() {
  const sessions = state.snapshot?.harness?.sessions || [];
  const runningSessions = sessions.filter((session) => session.running);
  const currentRunningIds = new Set(runningSessions.map((session) => session.id));
  if (state.runningSessionIds) {
    for (const id of state.runningSessionIds) {
      if (currentRunningIds.has(id)) continue;
      const completed = sessions.find((session) => session.id === id);
      if (completed) state.endedSessions.set(id, { ...completed, completedAt: Date.now() });
    }
  }
  for (const id of currentRunningIds) state.endedSessions.delete(id);
  state.runningSessionIds = currentRunningIds;
  const endedSessions = [...state.endedSessions.values()];
  $('#harnessSummary').textContent = `${runningSessions.length} 运行中 · ${sessions.length} 个未归档会话`;
  $('#compactHealthy').textContent = state.snapshot?.providers?.filter((p) => p.status === 'operational').length || 0;
  $('#compactWarning').textContent = state.snapshot?.providers?.filter((p) => ['degraded', 'unknown', 'disabled'].includes(p.status)).length || 0;
  $('#compactOutage').textContent = state.snapshot?.providers?.filter((p) => p.status === 'outage').length || 0;
  const runningOrbs = runningSessions.map((session, index) => orbSessionCard(session, false, index + 1));
  const endedOrbs = endedSessions.map((session, index) => orbSessionCard(session, true, runningOrbs.length + index + 1));
  $('#orbSessionList').innerHTML = [...runningOrbs, ...endedOrbs].join('') || '<button class="orb-session-card idle" data-orb-session="idle"><span class="orb-session-state"><span class="orb-session-status">空闲</span><span class="orb-session-index">任务 0</span></span><strong>DeepSeek</strong></button>';
  $('#harnessList').innerHTML = sessions.length ? sessions.map(harnessCard).join('') : '<div class="harness-empty">暂无未归档会话</div>';
  $('#compactHarnessList').innerHTML = [...runningSessions.map((session) => compactHarnessCard(session)), ...endedSessions.map((session) => compactHarnessCard(session, true))].join('');
  bindHarnessLinks(); resizeWindow(runningSessions.length + endedSessions.length);
}
function renderSnapshot() {
  renderSummary(); renderTypeTabs(); renderProviders(); renderHarness();
  const warning = state.snapshot.warning;
  $('#notice').textContent = warning;
  $('#notice').classList.toggle('hidden', !warning);
  $('#providerModuleSummary').textContent = `${state.snapshot?.providers?.length || 0} 个供应商`;
  requestAnimationFrame(resizeWindow);
}

async function refresh(manual = false) {
  if (state.refreshing || state.interactionPaused && !manual) return;
  state.refreshing = true;
  try { state.snapshot = manual ? await window.monitorAPI.refresh() : await window.monitorAPI.getSnapshot(); renderSnapshot(); resetCountdown(); }
  catch (error) { $('#summaryText').textContent = `刷新失败：${error.message}`; }
  finally { state.refreshing = false; }
}

function resetCountdown() {
  clearInterval(state.timer);
  state.remaining = Number(state.preferences?.refreshInterval || 60);
  state.timer = setInterval(() => {
    if (!state.preferences?.autoRefresh || state.interactionPaused) return;
    state.remaining -= 1;
    if (state.remaining <= 0) refresh(false);
  }, 1000);
}

async function updatePreference(key, value) {
  state.preferences = await window.monitorAPI.setPreference(key, value);
  resetCountdown();
}

function resizeWindow(runningSessions = (state.snapshot?.harness?.sessions?.filter((session) => session.running).length || 0) + state.endedSessions.size) {
  if (state.interactionPaused) { state.resizePending = true; return; }
  requestAnimationFrame(() => {
    const activeModule = state.view === 'harness' ? $('#harnessModule') : $('#providerModule');
    const contentHeight = ['compact', 'orb'].includes(state.view) ? 0 : Math.ceil(activeModule?.scrollHeight || 0);
    let visibleHeight;
    if (state.view === 'compact') visibleHeight = Math.ceil($('#compactCurrentArea').getBoundingClientRect().bottom) + Math.ceil($('#shell').getBoundingClientRect().top);
    else if (state.view === 'orb') visibleHeight = Math.ceil($('#orbSurface').scrollHeight);
    else visibleHeight = 58 + 4 + contentHeight + 4 + 42;
    window.monitorAPI.resizeView(state.view, runningSessions, contentHeight, visibleHeight);
  });
}
function applyView() {
  const compact = state.view === 'compact';
  const orb = state.view === 'orb';
  const activeModule = state.view === 'harness' ? 'harness' : 'provider';
  $('#shell').classList.toggle('compact', compact);
  $('#shell').classList.toggle('orb', orb);
  $('#shell').classList.remove('single-module', 'provider-only', 'harness-only');
  $('#providerModule').classList.toggle('expanded', !compact && !orb && activeModule === 'provider');
  $('#providerModule').classList.toggle('collapsed', compact || orb || activeModule !== 'provider');
  $('#harnessModule').classList.toggle('expanded', !compact && !orb && activeModule === 'harness');
  $('#harnessModule').classList.toggle('collapsed', compact || orb || activeModule !== 'harness');
  $('#collapseButton').title = compact ? '展开供应商' : '折叠悬浮窗';
  $('#collapseButton').setAttribute('aria-label', compact ? '展开全部' : '折叠悬浮窗');
  $('#collapseIcon').setAttribute('d', compact ? 'm8 10 4 4 4-4' : 'm8 14 4-4 4 4');
  resizeWindow();
}
function restoreCompact() {
  state.view = 'compact';
  applyView();
}
async function setCompact(compact) {
  state.view = compact ? 'compact' : 'provider';
  applyView();
}
async function showModule(module) {
  await window.monitorAPI.setCompact(false);
  state.view = module;
  applyView();
}

async function boot() {
  state.preferences = await window.monitorAPI.getPreferences();
  $('#alwaysOnTop').checked = true;
  $('#autoRefresh').checked = state.preferences.autoRefresh;
  $('#opacity').value = Math.round(state.preferences.opacity * 100);
  $('#opacityValue').textContent = `${$('#opacity').value}%`;
  $('#refreshInterval').value = String(state.preferences.refreshInterval);
  setCompact(state.preferences.compact);
  state.snapshot = await window.monitorAPI.getSnapshot();
  renderSnapshot(); resetCountdown();
}

// Refresh button removed from titlebar; kept only for defensive cleanup.
$('#settingsButton').addEventListener('click', () => { $('#settingsPanel').classList.toggle('open'); $('#settingsPanel').setAttribute('aria-hidden', !$('#settingsPanel').classList.contains('open')); });
$('#closeSettings').addEventListener('click', () => $('#settingsPanel').classList.remove('open'));
$('#hideButton').addEventListener('click', () => window.monitorAPI.hide());
$('#collapseButton').addEventListener('click', async () => {
  if (state.view === 'compact') { await window.monitorAPI.setCompact(false); state.view = 'provider'; }
  else { await window.monitorAPI.setCompact(true); state.view = 'compact'; }
  applyView();
});
$('#titlebar').addEventListener('dblclick', async (event) => {
  if (event.target.closest('button')) return;
  const compact = state.view !== 'compact';
  await window.monitorAPI.setCompact(compact);
  state.view = compact ? 'compact' : 'provider';
  applyView();
});
$('#orbButton').addEventListener('click', () => { state.view = 'orb'; applyView(); });
$('#compactProviderCard').addEventListener('click', () => showModule('provider'));
$('#providerModuleHeading').addEventListener('click', () => showModule('provider'));
$('#harnessModuleHeading').addEventListener('click', () => showModule('harness'));
$('#quitButton').addEventListener('click', () => window.monitorAPI.quit());
$('#searchInput').addEventListener('input', (event) => { state.query = event.target.value; renderProviders(); });
document.querySelectorAll('.overview button').forEach((button) => button.addEventListener('click', () => {
  state.filter = button.dataset.filter;
  document.querySelectorAll('.overview button').forEach((item) => item.classList.toggle('active', item.dataset.filter === state.filter));
  renderProviders();
}));
$('#autoRefresh').addEventListener('change', (event) => updatePreference('autoRefresh', event.target.checked));
$('#opacity').addEventListener('input', (event) => { $('#opacityValue').textContent = `${event.target.value}%`; updatePreference('opacity', Number(event.target.value) / 100); });
$('#refreshInterval').addEventListener('change', (event) => updatePreference('refreshInterval', Number(event.target.value)));
window.addEventListener('pointerdown', () => { state.interactionPaused = true; }, { capture: true });
function resumeInteraction() {
  if (!state.interactionPaused) return;
  state.interactionPaused = false;
  state.remaining = Number(state.preferences?.refreshInterval || 1);
  requestAnimationFrame(() => {
    if (state.resizePending) { state.resizePending = false; resizeWindow(); }
    refresh(false);
  });
}
window.addEventListener('pointerup', resumeInteraction, { capture: true });
window.addEventListener('pointercancel', resumeInteraction, { capture: true });
window.addEventListener('blur', resumeInteraction);
window.monitorAPI.onCompactChanged(setCompact);
window.addEventListener('keydown', (event) => { if (event.ctrlKey && event.key.toLowerCase() === 'r') { event.preventDefault(); refresh(true); } if (event.key === 'Escape') $('#settingsPanel').classList.remove('open'); });
boot();
