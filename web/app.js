import { createWorkspace } from '/workspace.js';
const $ = (id) => document.getElementById(id);
const ui = Object.fromEntries([...document.querySelectorAll('[id]')].map((element) => [element.id, element]));
const kindNames = { self: '本机', gateway: '默认网关', device: '网络设备' };
const statusNames = { online: '已确认在线', resolved: '已解析 · 在线状态未确认', cached: '缓存记录 · 在线状态未确认', unverified: '待确认' };
const evidenceNames = { self: '本机适配器', 'local-interface': '本机适配器', interface: '本机适配器', arp: 'ARP 地址解析', 'arp-response': 'ARP 地址解析', SendARP: 'ARP 地址解析', 'send-arp': 'ARP 地址解析', 'arp-cache': '系统邻居缓存', 'neighbor-cache': '系统邻居缓存', neighbor: '系统邻居记录', gateway: '默认网关配置', 'gateway-config': '默认网关配置', 'default-gateway': '默认网关配置', icmp: 'ICMP 响应', demo: '虚构演示数据' };
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let interfaces = [];
let interfaceId = '';
let realState = { status: 'idle', progress: null, result: null, error: null };
const realResults = new Map();
let demo = false;
let booting = true;
let stopped = false;
let scanStarting = false;
let selectedId = null;
let query = '';
let pollTimer = null;
let pollFailures = 0;
let toastTimer = null;
let scene = null;
let sceneError = false;
let sceneSignature = '';
let autoRotate = !reducedMotion.matches;
let lastRealSelection = null;
let demoResult = null;
let joinedScan = false;
let workspace = null;

function makeDemoResult() {
  const records = [
    ['1', 'Netspace Gateway', 'gateway', 'resolved', 'A4:5E:60:21:9B:01', 3.1],
    ['24', 'DESIGN-STUDIO', 'self', 'online', '6C:24:08:15:4A:24', null],
    ['12', 'MacBook Pro', 'device', 'resolved', 'E0:2B:E9:4F:73:12', 4.8],
    ['18', 'Living Room TV', 'device', 'resolved', '8C:79:F5:31:08:18', 6.2],
    ['31', 'iPhone', 'device', 'resolved', '7A:3B:C8:29:D0:31', 3.5],
    ['42', 'NAS Storage', 'device', 'resolved', '00:11:32:83:1A:42', 2.4],
    ['56', 'Wireless Printer', 'device', 'cached', '3C:52:82:18:6E:56', null],
    ['68', 'iPad Air', 'device', 'resolved', 'F2:39:B1:54:CE:68', 5.1],
    ['76', 'Home Speaker', 'device', 'resolved', '48:A6:B8:20:96:76', 7.3],
    ['88', 'Workstation', 'device', 'resolved', 'A8:5E:45:5C:B0:88', 2.8],
    ['102', 'Smart Bridge', 'device', 'cached', 'B0:55:08:22:DF:02', null],
    ['128', 'Network Device', 'device', 'unverified', null, null],
  ];
  const devices = records.map(([suffix, hostname, kind, status, mac, latencyMs]) => ({ id: '192.168.1.' + suffix, ip: '192.168.1.' + suffix, hostname, kind, status, mac, latencyMs, evidence: ['demo'] }));
  return { interface: { id: 'demo', alias: '演示网络', ip: '192.168.1.24', cidr: '192.168.1.0/24', scanCidr: '192.168.1.0/24', gateway: '192.168.1.1' }, devices, links: devices.slice(1).map((device) => ({ source: devices[0].id, target: device.id, kind: 'same-subnet', inferred: true })), scannedAt: new Date().toISOString(), durationMs: 1840, scope: { cidr: '192.168.1.0/24', scanCidr: '192.168.1.0/24', targetCount: 253, limited: false }, warnings: [] };
}

function activeResult() { return demo ? demoResult : workspace?.replayResult || realResults.get(interfaceId) || null; }
function currentInterface() { return interfaces.find((item) => String(item.id) === interfaceId) || null; }
function deviceName(device) { return device.profile?.alias || device.hostname || kindNames[device.kind] || '网络设备'; }
function isScanning() { return !stopped && (scanStarting || realState.status === 'scanning'); }
function deviceMatches(device) { return !query || [device.profile?.alias, device.profile?.notes, device.profile?.group, device.hostname, device.ip, device.mac, kindNames[device.kind], statusNames[device.status]].some((value) => String(value || '').toLocaleLowerCase().includes(query)); }
function text(id, value) { ui[id].textContent = value; }
function icon(name, className = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name); svg.append(use); return svg;
}
function showToast(message) {
  clearTimeout(toastTimer); text('toast', message); ui.toast.hidden = false;
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 3500);
}
function readTime(value) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return null;
  return { time: date.toLocaleTimeString('zh-CN', { hour12: false }), date: date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }) };
}
function saveResult(result) {
  if (!result || !Array.isArray(result.devices)) return;
  const id = String(result.interface?.id ?? interfaceId);
  realResults.set(id, result);
}
function applyState(state) {
  if (!state || !['idle', 'scanning', 'complete', 'error'].includes(state.status)) throw new Error('本机服务返回的状态无法识别。');
  const incoming = state.result;
  const previous = incoming?.networkId ? [...realResults.values()].find(result => result.networkId === incoming.networkId) : null;
  if (incoming && previous && Array.isArray(incoming.devices)) {
    const profiles = new Map(previous.devices.filter(device => device.deviceKey && device.profile).map(device => [device.deviceKey, device.profile]));
    incoming.devices = incoming.devices.map(device => profiles.has(device.deviceKey) ? { ...device, profile: { ...device.profile, ...profiles.get(device.deviceKey) } } : device);
  }
  realState = state; saveResult(state.result); pollFailures = 0;
  workspace?.observeState(state);
  if (joinedScan && state.status !== 'scanning') {
    const completedInterfaceId = String(state.result?.interface?.id ?? '');
    if (state.status === 'complete' && interfaces.some((adapter) => String(adapter.id) === completedInterfaceId)) {
      interfaceId = completedInterfaceId; ui['interface-select'].value = interfaceId; selectedId = null;
    }
    joinedScan = false;
  }
  render();
  if (state.status === 'scanning') schedulePoll(900); else clearTimeout(pollTimer);
}
async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 18000);
  try {
    const response = await fetch(path, { ...options, signal: controller.signal, cache: 'no-store', headers: { 'Content-Type': 'application/json', ...options.headers } });
    let data;
    try { data = await response.json(); } catch { throw new Error('本机服务没有返回有效数据，请重新连接。'); }
    if (!response.ok) { const error = new Error(data.error || '请求未能完成（' + response.status + '）。'); error.status = response.status; throw error; }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('本机服务响应超时，请重试。');
    if (error instanceof TypeError) throw new Error('无法连接本机服务，请确认程序仍在运行。');
    throw error;
  } finally { clearTimeout(timeout); }
}
function schedulePoll(delay) {
  clearTimeout(pollTimer);
  if (!stopped && realState.status === 'scanning') pollTimer = setTimeout(pollState, delay);
}
async function pollState() {
  if (stopped || realState.status !== 'scanning') return;
  try { applyState(await api('/api/state')); }
  catch (error) {
    pollFailures += 1;
    if (pollFailures >= 3) { realState = { ...realState, status: 'error', error: '扫描状态暂时无法读取。' + error.message }; render(); }
    else { text('progress-message', '连接暂时中断，正在重试…'); schedulePoll(1300 * pollFailures); }
  }
}
async function startScan() {
  if (stopped || scanStarting || isScanning() || !interfaceId || workspace?.replayResult) return;
  if (demo) setDemo(false);
  joinedScan = false;
  scanStarting = true; realState = { ...realState, status: 'scanning', error: null, progress: { phase: 'starting', completed: 0, total: 0, message: '正在准备发现设备…' } }; render();
  try {
    const state = await api('/api/scan', { method: 'POST', body: JSON.stringify({ interfaceId }) });
    scanStarting = false; applyState(state);
  } catch (error) {
    scanStarting = false;
    if (error.status === 409) {
      try { const runningState = await api('/api/state'); joinedScan = true; applyState(runningState); return; } catch (stateError) { error = stateError; }
    }
    realState = { ...realState, status: 'error', error: error.message }; render();
  }
}
async function initialize() {
  if (stopped || booting && interfaces.length) return false;
  booting = true; render();
  const [interfaceResponse, stateResponse] = await Promise.allSettled([api('/api/interfaces'), api('/api/state')]);
  let initialError = null;
  if (interfaceResponse.status === 'fulfilled') {
    interfaces = Array.isArray(interfaceResponse.value.interfaces) ? interfaceResponse.value.interfaces : [];
    initialError = interfaceResponse.value.error;
    const previousId = interfaceId;
    const resultId = stateResponse.status === 'fulfilled' ? String(stateResponse.value.result?.interface?.id ?? '') : '';
    interfaceId = interfaces.some((item) => String(item.id) === previousId) ? previousId : interfaces.some((item) => String(item.id) === resultId) ? resultId : String(interfaces[0]?.id ?? '');
    ui['interface-select'].replaceChildren();
    if (!interfaces.length) { const option = document.createElement('option'); option.textContent = '未找到可用的 IPv4 网络'; ui['interface-select'].append(option); }
    for (const adapter of interfaces) { const option = document.createElement('option'); option.value = String(adapter.id); option.textContent = (adapter.alias || '网络适配器') + ' · ' + adapter.ip; ui['interface-select'].append(option); }
    ui['interface-select'].value = interfaceId;
  } else initialError = interfaceResponse.reason.message;
  booting = false;
  if (stateResponse.status === 'fulfilled') {
    joinedScan = stateResponse.value.status === 'scanning';
    try { applyState(stateResponse.value); } catch (error) { initialError = error.message; }
  } else if (!initialError) initialError = stateResponse.reason.message;
  if (initialError) { realState = { ...realState, status: 'error', error: initialError }; render(); return false; }
  render();
  if (interfaceId && realState.status === 'idle' && !activeResult()) startScan();
  return true;
}

function renderList(devices, allCount) {
  ui['device-list'].replaceChildren();
  for (const device of devices) {
    const li = document.createElement('li');
    const button = document.createElement('button'); button.type = 'button'; button.className = 'device-row'; button.dataset.kind = device.kind || 'device'; button.dataset.deviceId = device.id;
    button.setAttribute('aria-pressed', String(device.id === selectedId));
    button.setAttribute('aria-label', deviceName(device) + '，' + device.ip + '，' + (statusNames[device.status] || '待确认'));
    const symbol = document.createElement('span'); symbol.className = 'device-row-icon'; symbol.append(icon(device.kind === 'gateway' ? 'router' : device.kind === 'self' ? 'laptop' : 'monitor'));
    const main = document.createElement('span'); main.className = 'device-row-main';
    const name = document.createElement('span'); name.className = 'device-row-name'; name.textContent = deviceName(device); name.title = deviceName(device);
    const ip = document.createElement('span'); ip.className = 'device-row-ip mono'; ip.textContent = device.ip;
    main.append(name, ip);
    const status = document.createElement('span'); status.className = 'device-row-status ' + (['online', 'resolved', 'cached', 'unverified'].includes(device.status) ? device.status : 'unverified'); status.title = statusNames[device.status] || '待确认';
    button.append(symbol, main, status, icon('arrow', 'icon device-row-chevron'));
    button.addEventListener('click', () => selectDevice(device.id)); li.append(button); ui['device-list'].append(li);
  }
  text('device-count', String(allCount)); text('filter-info', query ? devices.length + ' / ' + allCount : '全部设备');
  ui['list-empty'].hidden = devices.length > 0;
  ui['list-empty'].querySelector('p').textContent = query ? '没有匹配的设备，试试其他关键词。' : booting ? '正在读取本机网络…' : isScanning() && !demo ? '正在发现，稍后显示设备' : '设备将在发现后显示';
}
function renderDetails(device, result) {
  ui['detail-empty'].hidden = Boolean(device); ui['detail-content'].hidden = !device;
  if (!device) return;
  text('detail-kind', kindNames[device.kind] || '网络设备'); text('detail-name', deviceName(device));
  text('detail-ip-heading', device.ip || '未知地址'); text('detail-ip', device.ip || '未提供');
  text('detail-mac', device.mac || '未解析'); text('detail-hostname', device.hostname || '未获取');
  text('detail-latency', Number.isFinite(device.latencyMs) ? device.latencyMs.toFixed(1) + ' ms' : '未测得');
  text('detail-subnet', result.scope?.cidr || result.interface?.cidr || '未知');
  ui['detail-device-icon'].dataset.kind = device.kind; ui['detail-icon-use'].setAttribute('href', '#i-' + (device.kind === 'gateway' ? 'router' : device.kind === 'self' ? 'laptop' : 'monitor'));
  text('detail-status', statusNames[device.status] || '待确认'); ui['detail-status'].dataset.status = device.status || 'unverified';
  ui['detail-evidence'].replaceChildren();
  for (const evidence of device.evidence?.length ? device.evidence : ['未提供发现依据']) {
    const tag = document.createElement('span'); const key = typeof evidence === 'string' ? evidence : String(evidence?.type || evidence?.source || '系统记录'); tag.textContent = evidenceNames[key] || key; ui['detail-evidence'].append(tag);
  }
  text('detail-explanation', demo ? '演示设备为虚构数据。节点位置为模拟布局，连线仅示意同网段关系。' : '节点位置为模拟布局，不表示实际物理位置。地址解析可能使用缓存；连线仅为同网段推断，不表示已验证的物理连接。');
}
function selectDevice(id) {
  selectedId = id;
  const result = activeResult();
  if (result) renderDetails(result.devices.find((device) => device.id === id), result);
  workspace?.render(result, result?.devices.find((device) => device.id === id));
  for (const row of ui['device-list'].querySelectorAll('button')) row.setAttribute('aria-pressed', String(row.dataset.deviceId === id));
  scene?.setSelected(id);
}
function renderScene(result, visibleDevices) {
  if (!scene) return;
  const signature = JSON.stringify([demo, interfaceId, result?.scannedAt, result?.devices, result?.links]);
  if (signature !== sceneSignature) { scene.setDevices((result?.devices || []).map((device) => device.profile?.alias ? { ...device, displayName: device.profile.alias } : device), result?.links || []); sceneSignature = signature; }
  scene.setSelected(selectedId); scene.setFilter(query ? new Set(visibleDevices.map((device) => device.id)) : null);
}
function render() {
  const result = activeResult();
  const devices = result?.devices || [];
  const visibleDevices = devices.filter(deviceMatches);
  const adapter = currentInterface();
  const scanning = isScanning();
  const historical = Boolean(workspace?.replayResult) && !demo;
  if (!devices.some((device) => device.id === selectedId)) selectedId = devices.find((device) => device.kind === 'gateway')?.id || devices.find((device) => device.kind === 'self')?.id || devices[0]?.id || null;
  const scope = result?.scope?.scanCidr || result?.interface?.scanCidr || (demo ? '192.168.1.0/24' : adapter?.scanCidr || adapter?.cidr);
  text('stat-total', result ? String(devices.length).padStart(2, '0') : '—');
  text('stat-online', result ? String(devices.filter((device) => device.status === 'online').length).padStart(2, '0') : '—');
  text('stat-cidr', scope || (booting ? '正在读取…' : '等待适配器'));
  const limited = Boolean(result?.scope?.limited ?? adapter?.scopeLimited);
  text('stat-scope', demo ? '虚构演示范围' : limited ? '已限制发现范围 · 见底部提示' : 'IPv4 局域网 · 同网段发现');
  const stamp = readTime(result?.scannedAt);
  text('stat-time', stamp?.time || '--:--:--'); text('stat-date', demo ? '演示数据 · 非真实扫描结果' : historical ? (stamp?.date || '') + ' · 历史快照' : stamp?.date || '发现记录保存在本机');
  text('stat-duration', result ? (Number(result.durationMs || 0) / 1000).toFixed(1) + ' s' : '尚未发现');
  ui['demo-banner'].hidden = !demo; ui['demo-toggle'].setAttribute('aria-checked', String(demo));
  text('list-source', demo ? '虚构演示' : historical ? '历史快照' : '真实网络');
  ui['scene-mode'].classList.toggle('is-demo', demo || historical); ui['scene-mode'].lastChild.textContent = demo ? '模拟空间 · 虚构设备' : historical ? '模拟空间 · 历史快照' : '模拟空间 · 真实设备';
  ui['interface-select'].disabled = booting || scanning || stopped || !interfaces.length;
  ui['scan-button'].disabled = booting || scanning || stopped || !interfaceId || historical;
  text('scan-button-text', stopped ? '服务已停止' : scanning ? '正在发现…' : '发现设备');
  ui['export-button'].disabled = !result;
  ui['scan-progress'].hidden = !scanning || demo || historical;
  const progress = realState.progress || {};
  text('progress-message', progress.message || '正在发现设备…');
  text('progress-number', progress.total ? progress.completed + ' / ' + progress.total : '');
  ui['progress-bar'].style.width = progress.total ? Math.max(2, Math.min(100, Number(progress.completed || 0) / Number(progress.total) * 100)) + '%' : '5%';
  const warnings = result?.warnings?.filter(Boolean) || [];
  const error = !demo && !historical ? realState.error : null;
  const warningText = warnings.map((value) => typeof value === 'string' ? value : String(value.message || '')).filter(Boolean).join(' ');
  const fallbackWarning = limited && !warningText ? '当前网络范围较大，本次仅发现 ' + scope + ' 内的设备。' : '';
  text('notice', error ? '发现未完成：' + error + (result ? ' 当前仍显示上次发现结果。' : '') : warningText || fallbackWarning);
  ui.notice.hidden = demo || (!error && !warningText && !fallbackWarning);
  text('device-panel-note', demo ? '演示设备不代表当前网络' : historical ? '历史快照 · 非当前发现结果' : scanning ? '本次发现完成后更新结果' : devices.length ? '地址解析与系统邻居记录' : '从本机发现当前局域网');
  let footer = stopped ? '本机服务已停止' : demo ? '正在查看虚构演示数据' : historical ? '正在回看历史快照' : booting ? '正在连接本机服务' : scanning ? '正在发现设备' : error ? '发现遇到问题，可重新尝试' : result ? '本次发现已完成' : '等待发现设备';
  text('footer-status', footer); text('footer-range', '发现范围：' + (scope || '等待适配器'));
  ui['footer-dot'].style.background = error || stopped ? 'var(--amber)' : demo ? 'var(--amber)' : 'var(--mint)';
  const showEmpty = !devices.length || !visibleDevices.length || sceneError;
  ui['scene-empty'].hidden = !showEmpty;
  let emptyTitle = '等待发现你的网络'; let emptyDescription = '选择网络适配器，点击“发现设备”开始探索。';
  if (sceneError && devices.length) { emptyTitle = '当前环境无法显示三维空间'; emptyDescription = '设备数据已加载。你仍可通过设备列表查看详情和导出结果。'; }
  else if (query && !visibleDevices.length && devices.length) { emptyTitle = '未找到匹配设备'; emptyDescription = '调整左侧搜索关键词，继续探索网络空间。'; }
  else if (booting) { emptyTitle = '正在连接本机网络'; emptyDescription = '读取网络适配器后，将开始发现设备。'; }
  else if (!interfaceId && !demo) { emptyTitle = '没有可用的网络适配器'; emptyDescription = error || '请连接 Wi-Fi 或有线局域网，然后重新读取。'; }
  else if (error && !devices.length) { emptyTitle = '暂时无法发现设备'; emptyDescription = error; }
  else if (scanning && !demo) { emptyTitle = '正在发现身边的设备'; emptyDescription = '地址解析与系统记录采集正在进行，完成后将在此显示。'; }
  else if (result && !devices.length) { emptyTitle = '本次未发现设备'; emptyDescription = '确认所选适配器已连接到局域网后，再次尝试发现。'; }
  text('scene-empty-title', emptyTitle); text('scene-empty-description', emptyDescription);
  ui['retry-button'].hidden = demo || booting || scanning || (!error && Boolean(interfaceId));
  ui['retry-button'].textContent = interfaces.length ? '重新发现' : '重新读取适配器';
  text('scene-hint', sceneError ? '设备列表与导出功能仍可使用' : '拖动旋转 · 滚轮缩放 · 点击设备查看');
  renderList(visibleDevices, devices.length); renderDetails(devices.find((device) => device.id === selectedId), result); renderScene(result, visibleDevices);
  workspace?.render(result, devices.find((device) => device.id === selectedId));
}

function setDemo(value) {
  if (value === demo) return;
  if (value) { lastRealSelection = selectedId; demoResult ||= makeDemoResult(); workspace?.leaveReplay(false); }
  demo = value; query = ''; ui['device-search'].value = ''; selectedId = value ? null : lastRealSelection;
  render();
}

ui['demo-toggle'].addEventListener('click', () => setDemo(!demo));
ui['leave-demo'].addEventListener('click', () => setDemo(false));
async function retryDiscovery() { const refreshed = await initialize(); if (refreshed && interfaceId && !isScanning()) startScan(); }
ui['scan-button'].addEventListener('click', () => realState.status === 'error' ? retryDiscovery() : startScan());
ui['interface-select'].addEventListener('change', () => { workspace?.leaveReplay(false); interfaceId = ui['interface-select'].value; selectedId = null; query = ''; ui['device-search'].value = ''; if (realState.status === 'error') realState = { ...realState, status: 'idle', error: null }; render(); });
ui['device-search'].addEventListener('input', () => { query = ui['device-search'].value.trim().toLocaleLowerCase(); render(); });
ui['retry-button'].addEventListener('click', retryDiscovery);
ui['rotate-button'].addEventListener('click', () => { autoRotate = !autoRotate; updateRotate(); });
function updateRotate() { scene?.setAutoRotate(autoRotate); ui['rotate-button'].setAttribute('aria-pressed', String(autoRotate)); ui['rotate-button'].setAttribute('aria-label', autoRotate ? '暂停自动旋转' : '开启自动旋转'); ui['rotate-button'].title = autoRotate ? '暂停自动旋转' : '开启自动旋转'; }
reducedMotion.addEventListener('change', (event) => { if (event.matches) { autoRotate = false; updateRotate(); } });
ui['reset-button'].addEventListener('click', () => { scene?.reset(); showToast('已重置空间视角'); });
ui['copy-ip'].addEventListener('click', async () => { const device = activeResult()?.devices.find((item) => item.id === selectedId); if (!device) return; try { await navigator.clipboard.writeText(device.ip); showToast('IP 地址已复制'); } catch { showToast('无法自动复制，请从详情中选取 IP 地址。'); } });
ui['export-button'].addEventListener('click', () => {
  const result = activeResult(); if (!result) return;
  const historical = !demo && Boolean(workspace?.replayResult);
  const data = { ...result, source: demo ? 'synthetic-demo' : historical ? 'local-network-history' : 'local-network-discovery', historical, exportedAt: new Date().toISOString(), visualization: { layout: 'simulated', physicalPositions: false, links: 'inferred-same-subnet', onlineStatus: 'Address resolution and cache entries do not guarantee that a device is online.' } };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'netspace-' + (demo ? 'DEMO-' : historical ? 'HISTORY-' : '') + new Date().toISOString().replace(/[:.]/g, '-') + '.json'; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); showToast(demo ? '已导出演示数据（含虚构标记）' : historical ? '已导出历史快照（含历史标记）' : '已导出本次发现结果');
});
ui['shutdown-button'].addEventListener('click', async () => {
  if (stopped) return;
  ui['shutdown-button'].disabled = true;
  try { await api('/api/shutdown', { method: 'POST', body: '{}' }); stopped = true; clearTimeout(pollTimer); workspace?.destroy(); realState = { ...realState, status: 'idle' }; render(); showToast('本机服务已停止，当前结果仍可查看和导出。'); ui['shutdown-button'].textContent = '服务已停止'; }
  catch (error) { showToast(error.message); ui['shutdown-button'].disabled = false; }
});

async function initializeScene() {
  try {
    const { createNetworkScene } = await import('/scene.js');
    scene = createNetworkScene({ container: ui['scene-canvas'], labels: ui['scene-labels'], onSelect: selectDevice }); updateRotate(); render();
  } catch (error) { console.warn('Three-dimensional view unavailable:', error); sceneError = true; ui['rotate-button'].disabled = true; ui['reset-button'].disabled = true; render(); }
}
workspace = createWorkspace({
  ui, api, rerender: render, showToast, activeResult, readState: () => realState, applyState,
  getLiveResult: () => realResults.get(interfaceId) || null, getInterfaceId: () => interfaceId,
  isDemo: () => demo, isStopped: () => stopped, selectedDevice: () => activeResult()?.devices.find((device) => device.id === selectedId),
  enterReplay: () => { demo = false; selectedId = null; query = ''; ui['device-search'].value = ''; render(); },
  leaveReplay: () => { selectedId = null; query = ''; ui['device-search'].value = ''; render(); },
  patchProfile: (networkId, deviceKey, profile) => { for (const result of realResults.values()) if (result.networkId === networkId) for (const device of result.devices) if (device.deviceKey === deviceKey) device.profile = { ...profile }; },
});
window.addEventListener('pagehide', () => { clearTimeout(pollTimer); workspace?.destroy(); scene?.destroy(); });
updateRotate();
initializeScene();
initialize().then(() => workspace.initialize());
