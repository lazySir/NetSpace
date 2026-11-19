import { buildHistoryComparisonCsv } from '/csv.js';
import { deviceIdentity } from '/identity.js';
const EMPTY_PROFILE = { alias: '', notes: '', group: '', known: false, ignored: false };
const EVENT_LABELS = { new: '新设备', returned: '再次发现', not_seen: '本次未见', ip_changed: 'IP 已变化' };

// Persistent records belong to the server; view modes and unsaved drafts stay local.
export function createWorkspace(options) {
  const { ui, api, rerender, showToast } = options;
  let monitor = { enabled: false, interfaceId: null, intervalSeconds: 300, nextScanAt: null, error: null, notificationsEnabled: true };
  let ready = false, busy = false, destroyed = false, refreshing = false, timer = null, settingsGeneration = 0;
  let replay = null, replayRequest = 0, networkId = '', pinnedNetwork = false, tab = 'devices';
  let comparisonSourceId = '', comparisonTargetId = '', comparisonResult = null, comparisonError = '', comparisonLoading = false, comparisonRequest = 0;
  let wasDemo = false;
  let networks = [], scans = [], events = [], records = [];
  let unreadCount = 0, archiveError = '', monitorError = '', loadingReplay = false;
  let desktopNotificationsBusy = false;
  let networkSignature = '', historySignature = '', eventSignature = '', liveSignature = '';
  const drafts = new Map(), notifiedEvents = new Set();
  let profileKey = '';

  function resetComparison(clearSelection = true) {
    comparisonRequest++; comparisonResult = null; comparisonError = ''; comparisonLoading = false;
    if (clearSelection) { comparisonSourceId = ''; comparisonTargetId = ''; }
  }

  function readonly() { return options.isDemo() || Boolean(replay) || options.isStopped(); }
  function stamp(value) {
    const date = new Date(value);
    return value && Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '未记录';
  }
  function message(element, value) { element.textContent = value || ''; element.hidden = !value; }
  function setTab(value, focus = false) {
    tab = value;
    for (const name of ['devices', 'history', 'events']) {
      ui['tab-' + name].setAttribute('aria-selected', String(name === tab));
      ui['tab-' + name].tabIndex = name === tab ? 0 : -1;
      ui[name + '-pane'].hidden = name !== tab;
    }
    ui['archive-controls'].hidden = tab === 'devices';
    if (focus) ui['tab-' + tab].focus();
  }
  for (const name of ['devices', 'history', 'events']) {
    ui['tab-' + name].addEventListener('click', () => setTab(name));
    ui['tab-' + name].addEventListener('keydown', event => {
      const tabs = ['devices', 'history', 'events'];
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (tabs.indexOf(name) + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
      setTab(tabs[index], true);
    });
  }

  function renderMonitor() {
    const locked = readonly() || !ready || busy;
    ui['monitor-interval'].disabled = locked;
    if (document.activeElement !== ui['monitor-interval']) ui['monitor-interval'].value = String(monitor.intervalSeconds);
    ui['monitor-toggle'].disabled = locked || (!monitor.enabled && !/^[0-9]+$/.test(options.getInterfaceId()));
    ui['monitor-toggle'].textContent = busy ? '正在更新…' : monitor.enabled ? '停止定时' : '开始定时';
    ui['mute-toggle'].disabled = locked;
    ui['mute-toggle'].setAttribute('aria-pressed', String(!monitor.notificationsEnabled));
    ui['mute-toggle'].textContent = monitor.notificationsEnabled ? '提醒已开启' : '提醒已静音';
    const notificationApi = typeof window.Notification === 'function' ? window.Notification : null;
    const permission = notificationApi?.permission || 'unsupported';
    const canRequestPermission = permission === 'default' && typeof notificationApi?.requestPermission === 'function';
    ui['desktop-notifications-toggle'].disabled = locked || desktopNotificationsBusy || !canRequestPermission;
    ui['desktop-notifications-toggle'].textContent = desktopNotificationsBusy ? '正在请求权限…'
      : permission === 'granted' ? '桌面提醒已开启'
        : permission === 'denied' ? '系统已阻止桌面提醒'
          : permission === 'unsupported' ? '当前环境不支持' : '启用桌面提醒';
    const desktopStatus = permission === 'granted'
      ? '桌面提醒已获授权；浏览器页面保持打开时，新设备可显示为 Windows 通知。'
      : permission === 'denied'
        ? '系统已阻止桌面提醒；可在浏览器的网站权限中重新开启，页面内提醒仍可使用。'
        : permission === 'unsupported'
          ? '当前浏览器不支持桌面提醒；页面内提醒仍可使用。'
          : '需要你点击启用后才会请求系统权限；通知只提示新设备数量，不显示名称或地址。';
    ui['desktop-notifications-status'].textContent = desktopStatus;
    ui['monitor-status'].textContent = options.isStopped() ? '已停止' : !ready ? '正在读取设置' : monitor.enabled ? '运行中 · 每 ' + (monitor.intervalSeconds / 60) + ' 分钟' : '尚未开启';
    ui['monitor-dot'].style.background = !options.isStopped() && monitor.enabled ? 'var(--mint)' : '#668195';
    ui['monitor-next'].textContent = '下一次：' + (!options.isStopped() && monitor.enabled && monitor.nextScanAt ? stamp(monitor.nextScanAt) : '—');
    const reason = options.isDemo() ? '演示模式仅供查看；后台真实网络的定时设置保持生效。' : replay ? '历史快照仅供查看；返回当前网络后可编辑档案与定时设置。' : '';
    message(ui['monitor-message'], monitorError || monitor.error || reason);
  }
  function renderNetworks() {
    const signature = JSON.stringify(networks.map(item => [item.id, item.label, item.cidr]));
    if (networkSignature !== signature) {
      networkSignature = signature; ui['network-filter'].replaceChildren();
      if (!networks.length) { const option = document.createElement('option'); option.value = ''; option.textContent = '尚无本地记录'; ui['network-filter'].append(option); }
      for (const network of networks) { const option = document.createElement('option'); option.value = network.id; option.textContent = (network.label || '本地网络') + ' · ' + (network.cidr || '未知网段'); ui['network-filter'].append(option); }
    }
    ui['network-filter'].value = networkId;
    ui['network-filter'].disabled = !networks.length || options.isStopped();
  }
  function renderHistory() {
    const inDemo = options.isDemo();
    if (inDemo && !wasDemo) resetComparison(false);
    wasDemo = inDemo;
    ui['history-comparison-section'].hidden = inDemo;
    const signature = JSON.stringify([networkId, scans]);
    if (signature !== historySignature) {
      historySignature = signature; ui['history-scan'].replaceChildren();
      let comparisonSelectionPruned = false;
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = scans.length ? '选择发现记录，查看当时设备' : '该网络尚无历史记录'; ui['history-scan'].append(placeholder);
      for (const scan of scans) {
        const option = document.createElement('option'); option.value = String(scan.id);
        option.textContent = stamp(scan.scannedAt) + ' · ' + scan.deviceCount + ' 台 · ' + Number(scan.changeCount || 0) + ' 项变化';
        ui['history-scan'].append(option);
      }
      for (const [id, prompt] of [['history-compare-source', '选择起始快照'], ['history-compare-target', '选择对比快照']]) {
        const select = ui[id], previous = id === 'history-compare-source' ? comparisonSourceId : comparisonTargetId;
        select.replaceChildren();
        const choice = document.createElement('option'); choice.value = ''; choice.textContent = prompt; select.append(choice);
        for (const scan of scans) {
          const option = document.createElement('option'); option.value = String(scan.id);
          option.textContent = stamp(scan.scannedAt) + ' · ' + scan.deviceCount + ' 台'; select.append(option);
        }
        const validPrevious = scans.some(scan => String(scan.id) === previous);
        const fallback = id === 'history-compare-source' ? (scans.length > 1 ? String(scans[1].id) : '') : (scans.length ? String(scans[0].id) : '');
        const nextSelection = validPrevious ? previous : fallback;
        if (previous && previous !== nextSelection) comparisonSelectionPruned = true;
        if (id === 'history-compare-source') comparisonSourceId = nextSelection;
        else comparisonTargetId = nextSelection;
        select.value = id === 'history-compare-source' ? comparisonSourceId : comparisonTargetId;
      }
      if (comparisonSelectionPruned) resetComparison(false);
    }
    ui['history-scan'].disabled = !scans.length || options.isStopped() || loadingReplay || options.isDemo();
    ui['history-scan'].value = replay && replay.networkId === networkId ? String(replay.scanId) : '';
    const compareLocked = !scans.length || options.isStopped() || options.isDemo() || comparisonLoading;
    ui['history-compare-source'].disabled = compareLocked; ui['history-compare-target'].disabled = compareLocked;
    ui['history-compare-button'].disabled = compareLocked || !comparisonSourceId || !comparisonTargetId || comparisonSourceId === comparisonTargetId;
    renderComparison();
    ui['replay-banner'].hidden = !replay || options.isDemo();
    ui['replay-description'].textContent = replay ? stamp(replay.scannedAt) + ' · ' + (replay.interface?.cidr || '') + ' · 仅供查看' : '';
    message(ui['archive-message'], loadingReplay ? '正在读取历史快照…' : archiveError);
  }
  function renderComparison() {
    const list = ui['history-comparison-list'], status = ui['history-comparison-status'];
    const differenceCount = comparisonResult ? comparisonResult.added.length + comparisonResult.changed.length + comparisonResult.missing.length : 0;
    ui['history-csv-button'].disabled = options.isStopped() || options.isDemo() || comparisonLoading || differenceCount === 0;
    list.replaceChildren();
    if (comparisonLoading) { status.textContent = '正在读取两次本地快照…'; return; }
    if (comparisonError) { status.textContent = comparisonError; return; }
    if (!comparisonResult) { status.textContent = '选择两次同一网络的发现记录，查看设备变化。'; return; }
    const { added, missing, changed, unchanged, source, target } = comparisonResult;
    status.textContent = stamp(source.scannedAt) + ' → ' + stamp(target.scannedAt) + ' · 新增 ' + added.length + ' · IP 变化 ' + changed.length + ' · 本次未见 ' + missing.length + ' · 未变化 ' + unchanged;
    const entries = [
      ...added.map(device => ({ kind: 'added', label: '新增', device, address: device.ip || '未知地址' })),
      ...changed.map(item => ({ kind: 'ip-changed', label: 'IP 变化', device: item.after, address: (item.before.ip || '未知地址') + ' → ' + (item.after.ip || '未知地址') })),
      ...missing.map(device => ({ kind: 'missing', label: '本次未见', device, address: device.ip || '未知地址' })),
    ];
    for (const entry of entries) {
      const row = document.createElement('li'); row.dataset.changeKind = entry.kind;
      const label = document.createElement('span'); label.className = 'comparison-kind'; label.textContent = entry.label;
      const name = document.createElement('span'); name.className = 'comparison-device'; name.textContent = entry.device.profile?.alias || entry.device.hostname || '网络设备';
      const address = document.createElement('span'); address.className = 'comparison-address mono'; address.textContent = entry.address;
      row.append(label, name, address); list.append(row);
    }
    if (!entries.length) { const empty = document.createElement('li'); empty.className = 'comparison-no-change'; empty.textContent = '两次快照中的设备身份与 IP 地址没有可见变化。'; list.append(empty); }
  }
  function exportHistoryComparison() {
    if (!comparisonResult || options.isDemo() || options.isStopped()
      || comparisonResult.added.length + comparisonResult.changed.length + comparisonResult.missing.length === 0) return;
    const csv = buildHistoryComparisonCsv(comparisonResult, { exportedAt: new Date().toISOString() });
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url;
    anchor.download = 'netspace-HISTORY-DIFF-' + new Date().toISOString().replace(/[:.]/g, '-') + '.csv';
    document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('已导出 ' + (comparisonResult.added.length + comparisonResult.changed.length + comparisonResult.missing.length) + ' 项历史差异');
  }
  async function compareHistory() {
    if (options.isDemo() || options.isStopped() || !networkId) return;
    const sourceId = comparisonSourceId, targetId = comparisonTargetId, expectedNetwork = networkId;
    if (!sourceId || !targetId || sourceId === targetId) return;
    const request = ++comparisonRequest; comparisonLoading = true; comparisonError = ''; comparisonResult = null; rerender();
    try {
      const [sourceData, targetData] = await Promise.all([
        api('/api/history/' + encodeURIComponent(sourceId)), api('/api/history/' + encodeURIComponent(targetId)),
      ]);
      if (request !== comparisonRequest || destroyed || options.isDemo() || networkId !== expectedNetwork
        || comparisonSourceId !== sourceId || comparisonTargetId !== targetId) return;
      for (const [id, data] of [[sourceId, sourceData], [targetId, targetData]]) {
        if (!data.result || !Array.isArray(data.result.devices) || data.result.networkId !== expectedNetwork || String(data.result.scanId) !== id) {
          throw new Error('快照不属于当前网络或记录已变化，请重新选择。');
        }
      }
      const before = new Map(sourceData.result.devices.map(device => [deviceIdentity(device), device]));
      const after = new Map(targetData.result.devices.map(device => [deviceIdentity(device), device]));
      const added = [], missing = [], changed = []; let unchanged = 0;
      for (const [identity, device] of after) {
        const previous = before.get(identity);
        if (!previous) added.push(device);
        else if (previous.ip !== device.ip) changed.push({ before: previous, after: device });
        else unchanged++;
      }
      for (const [identity, device] of before) if (!after.has(identity)) missing.push(device);
      comparisonResult = { source: sourceData.result, target: targetData.result, added, missing, changed, unchanged };
    } catch (error) { if (request === comparisonRequest) comparisonError = '无法比较：' + error.message; }
    finally { if (request === comparisonRequest && !destroyed) { comparisonLoading = false; rerender(); } }
  }
  function renderEvents() {
    ui['unread-count'].textContent = String(unreadCount);
    ui['unread-count'].classList.toggle('has-unread', unreadCount > 0);
    ui['unread-count'].setAttribute('aria-label', unreadCount + ' 条未读提醒');
    ui['events-read'].disabled = unreadCount <= 0 || readonly() || busy;
    const signature = JSON.stringify([networkId, events]);
    if (signature !== eventSignature) {
      eventSignature = signature; ui['event-list'].replaceChildren();
      for (const event of events) {
        const li = document.createElement('li'); li.classList.toggle('is-unread', !event.read && event.notify); li.dataset.eventId = String(event.id);
        const header = document.createElement('div'); header.className = 'event-header';
        const kind = document.createElement('span'); kind.textContent = EVENT_LABELS[event.kind] || '发现记录';
        const time = document.createElement('time'); time.dateTime = event.occurredAt || ''; time.textContent = stamp(event.occurredAt); header.append(kind, time);
        const name = document.createElement('p'); name.className = 'event-name'; name.textContent = event.name || event.ip || '网络设备';
        const ip = document.createElement('p'); ip.className = 'event-address mono'; ip.textContent = event.kind === 'ip_changed' && event.previousIp ? event.previousIp + ' → ' + event.ip : event.ip || '';
        li.append(header, name, ip); ui['event-list'].append(li);
      }
    }
    ui['events-empty'].hidden = events.length > 0;
  }
  function renderProfile(result, device) {
    if (!device) { profileKey = ''; return; }
    const mode = options.isDemo() ? 'demo' : replay ? 'history:' + replay.scanId : 'live';
    const key = mode + ':' + (result?.networkId || '') + ':' + (device.deviceKey || device.id);
    const persistent = Boolean(result?.networkId && device.deviceKey);
    const serverProfile = { ...EMPTY_PROFILE, ...device.profile };
    let draft = drafts.get(key);
    if (!draft) { draft = { values: serverProfile, dirty: false, saving: false, error: false, message: '' }; drafts.set(key, draft); }
    if (!draft.dirty && !draft.saving) draft.values = serverProfile;
    const changed = profileKey !== key; profileKey = key;
    for (const field of ['alias', 'notes', 'group', 'known', 'ignored']) {
      const input = ui['profile-' + field], value = draft.values[field];
      if (changed || !draft.dirty && !draft.saving) { if (input.type === 'checkbox') input.checked = Boolean(value); else if (input.value !== value) input.value = value || ''; }
      input.disabled = readonly() || !persistent || draft.saving || !ready;
    }
    const record = !replay && !options.isDemo() ? records.find(item => item.deviceKey === device.deviceKey && result.networkId === networkId) : null;
    ui['profile-first-seen'].textContent = stamp(device.firstSeen || record?.firstSeen);
    ui['profile-last-seen'].textContent = stamp(device.lastSeen || record?.lastSeen);
    ui['profile-save'].disabled = readonly() || !persistent || draft.saving || !ready;
    ui['profile-save'].textContent = draft.saving ? '正在保存…' : '保存档案';
    ui['profile-status'].textContent = options.isDemo() ? '演示数据不可编辑' : replay ? '历史快照不可编辑' : !persistent ? '发现完成后可保存档案' : draft.message || (draft.dirty ? '有未保存的更改' : '');
    ui['profile-status'].classList.toggle('is-error', draft.error);
  }
  function render(result, device) { renderMonitor(); renderNetworks(); renderHistory(); renderEvents(); renderProfile(result, device); }
  function maybeNotify() {
    if (readonly() || busy || !monitor.notificationsEnabled) return;
    const fresh = events.filter(event => event.kind === 'new' && event.notify && !event.read && !notifiedEvents.has(event.id));
    if (!fresh.length) return;
    let delivered = false;
    if (typeof window.Notification === 'function' && window.Notification.permission === 'granted') {
      try {
        const notification = new window.Notification('NetSpace · 网络变化', {
          body: '发现 ' + fresh.length + ' 台新设备。打开应用查看变化记录。',
          tag: 'netspace-new-devices',
        });
        notification.onclick = () => { window.focus(); notification.close?.(); };
        delivered = true;
      } catch {
        delivered = false;
      }
    }
    for (const event of fresh) notifiedEvents.add(event.id);
    if (!delivered) showToast('发现 ' + fresh.length + ' 台新设备，请查看“变化”记录。');
  }
  async function loadNetworkRecords() {
    const expected = networkId;
    const requestedSettingsGeneration = settingsGeneration;
    if (!expected) { scans = []; events = []; records = []; unreadCount = 0; rerender(); return; }
    const query = '?networkId=' + encodeURIComponent(expected);
    const responses = await Promise.allSettled([api('/api/history' + query + '&limit=50'), api('/api/events' + query + '&limit=50'), api('/api/devices' + query)]);
    if (destroyed || networkId !== expected) return;
    const [history, changes, devices] = responses;
    const errors = responses.filter(item => item.status === 'rejected');
    archiveError = errors.length ? '本地记录暂时无法读取：' + errors[0].reason.message : '';
    if (history.status === 'fulfilled') scans = Array.isArray(history.value.scans) ? history.value.scans : [];
    if (changes.status === 'fulfilled') {
      events = Array.isArray(changes.value.events) ? changes.value.events : []; unreadCount = Number(changes.value.unreadCount || 0);
    }
    if (devices.status === 'fulfilled') records = Array.isArray(devices.value.devices) ? devices.value.devices : [];
    rerender();
    if (requestedSettingsGeneration === settingsGeneration) maybeNotify();
  }
  async function refresh(readLive = false) {
    if (destroyed || options.isStopped() || refreshing) return;
    refreshing = true;
    const requestedSettingsGeneration = settingsGeneration;
    try {
      const [settings, catalogue] = await Promise.allSettled([api('/api/monitor'), api('/api/networks')]);
      if (destroyed) return;
      if (settings.status === 'fulfilled' && settingsGeneration === requestedSettingsGeneration) { monitor = { ...monitor, ...settings.value }; ready = true; monitorError = ''; }
      else if (settings.status === 'fulfilled') ready = true;
      else monitorError = settings.reason.message;
      if (catalogue.status === 'fulfilled') networks = Array.isArray(catalogue.value.networks) ? catalogue.value.networks : [];
      else archiveError = catalogue.reason.message;
      const liveId = options.getLiveResult()?.networkId;
      const nextNetworkId = !pinnedNetwork && liveId && networks.some(item => item.id === liveId)
        ? liveId : networks.some(item => item.id === networkId) ? networkId : networks[0]?.id || '';
      if (nextNetworkId !== networkId) {
        networkId = nextNetworkId; resetComparison(); scans = []; events = []; records = []; unreadCount = 0; archiveError = '';
      }
      rerender();
      if (ready && (readLive || monitor.enabled) && options.readState().status !== 'scanning') {
        try { options.applyState(await api('/api/state')); } catch (error) { monitorError = '定时发现状态暂时无法读取：' + error.message; }
      }
      await loadNetworkRecords();
    } finally { refreshing = false; if (!destroyed && !options.isStopped()) { clearTimeout(timer); timer = setTimeout(() => refresh(true), 3000); } }
  }
  async function updateMonitor(changes) {
    if (readonly() || !ready || busy) return;
    const generation = ++settingsGeneration; busy = true; monitorError = ''; rerender();
    try { monitor = { ...monitor, ...await api('/api/monitor', { method: 'POST', body: JSON.stringify(changes) }) }; }
    catch (error) { monitorError = '设置未保存：' + error.message; }
    finally { if (generation === settingsGeneration) { busy = false; rerender(); } }
  }
  ui['monitor-toggle'].addEventListener('click', () => updateMonitor(monitor.enabled ? { enabled: false } : { enabled: true, interfaceId: options.getInterfaceId(), intervalSeconds: Number(ui['monitor-interval'].value) }));
  ui['monitor-interval'].addEventListener('change', () => updateMonitor({ intervalSeconds: Number(ui['monitor-interval'].value) }));
  ui['mute-toggle'].addEventListener('click', () => updateMonitor({ notificationsEnabled: !monitor.notificationsEnabled }));
  ui['desktop-notifications-toggle'].addEventListener('click', async () => {
    if (readonly() || !ready || busy || desktopNotificationsBusy) return;
    const notificationApi = typeof window.Notification === 'function' ? window.Notification : null;
    if (!notificationApi || typeof notificationApi.requestPermission !== 'function') {
      showToast('当前浏览器不支持桌面提醒，可继续使用页面内提醒。');
      return;
    }
    if (notificationApi.permission !== 'default') return;
    desktopNotificationsBusy = true; rerender();
    try {
      const permission = await notificationApi.requestPermission();
      showToast(permission === 'granted' ? '桌面提醒已开启，可随时使用静音按钮暂停提醒。'
        : '未获桌面提醒权限；页面内提醒仍可使用。');
    } catch {
      showToast('未能启用桌面提醒；页面内提醒仍可使用。');
    } finally { desktopNotificationsBusy = false; rerender(); }
  });
  ui['network-filter'].addEventListener('change', () => {
    networkId = ui['network-filter'].value; pinnedNetwork = true; replayRequest++; replay = null; loadingReplay = false;
    resetComparison();
    scans = []; events = []; records = []; unreadCount = 0; archiveError = ''; rerender(); loadNetworkRecords();
  });
  for (const id of ['history-compare-source', 'history-compare-target']) ui[id].addEventListener('change', () => {
    comparisonRequest++; comparisonLoading = false;
    if (id === 'history-compare-source') comparisonSourceId = ui[id].value; else comparisonTargetId = ui[id].value;
    comparisonResult = null; comparisonError = ''; renderComparison();
    ui['history-compare-button'].disabled = options.isStopped() || options.isDemo() || comparisonLoading || !comparisonSourceId || !comparisonTargetId || comparisonSourceId === comparisonTargetId;
  });
  ui['history-compare-button'].addEventListener('click', compareHistory);
  ui['history-csv-button'].addEventListener('click', exportHistoryComparison);
  ui['history-scan'].addEventListener('change', async () => {
    const id = ui['history-scan'].value;
    if (!id || options.isDemo() || options.isStopped()) return;
    const request = ++replayRequest, expectedNetwork = networkId; loadingReplay = true; archiveError = ''; rerender();
    try {
      const data = await api('/api/history/' + encodeURIComponent(id));
      if (request !== replayRequest || destroyed) return;
      if (!data.result || !Array.isArray(data.result.devices) || data.result.networkId !== expectedNetwork) throw new Error('历史快照不属于所选网络，请重新选择。');
      replay = data.result; options.enterReplay();
    } catch (error) { if (request === replayRequest) archiveError = '无法回看：' + error.message; }
    finally { if (request === replayRequest) { loadingReplay = false; rerender(); } }
  });
  function leaveReplay(renderNow = true) { replayRequest++; replay = null; loadingReplay = false; if (renderNow) { options.leaveReplay(); maybeNotify(); } }
  ui['return-current'].addEventListener('click', () => leaveReplay());
  for (const field of ['alias', 'notes', 'group', 'known', 'ignored']) {
    ui['profile-' + field].addEventListener('input', () => {
      const draft = drafts.get(profileKey); if (!draft || readonly()) return;
      const input = ui['profile-' + field]; draft.values = { ...draft.values, [field]: input.type === 'checkbox' ? input.checked : input.value };
      draft.dirty = true; draft.error = false; draft.message = ''; renderProfile(options.activeResult(), options.selectedDevice());
    });
  }
  ui['profile-form'].addEventListener('submit', async event => {
    event.preventDefault(); const result = options.activeResult(), device = options.selectedDevice(), draft = drafts.get(profileKey);
    if (readonly() || !ready || !result?.networkId || !device?.deviceKey || !draft || draft.saving) return;
    const key = profileKey, network = result.networkId, deviceKey = device.deviceKey, values = { ...draft.values };
    draft.saving = true; draft.error = false; draft.message = ''; rerender();
    try {
      const response = await api('/api/profile', { method: 'POST', body: JSON.stringify({ networkId: network, deviceKey, ...values }) });
      draft.values = { ...EMPTY_PROFILE, ...response.profile }; draft.dirty = false; draft.message = '已保存到本机';
      options.patchProfile(network, deviceKey, draft.values);
      for (const record of records) if (record.deviceKey === deviceKey && networkId === network) record.profile = draft.values;
      await loadNetworkRecords();
    } catch (error) { draft.error = true; draft.message = '保存失败：' + error.message; }
    finally { draft.saving = false; if (drafts.has(key)) rerender(); }
  });
  ui['events-read'].addEventListener('click', async () => {
    if (readonly() || busy) return;
    if (unreadCount <= 0 || !networkId) return;
    busy = true; archiveError = ''; rerender();
    try { await api('/api/events/read', { method: 'POST', body: JSON.stringify({ networkId, allUnread: true }) }); await loadNetworkRecords(); }
    catch (error) { archiveError = '未能标为已读：' + error.message; }
    finally { busy = false; rerender(); }
  });
  return {
    get replayResult() { return replay; }, render, initialize: refresh, leaveReplay,
    observeState(state) {
      if (state.monitor && !ready) { monitor = { ...monitor, ...state.monitor }; ready = true; }
      const signature = JSON.stringify([state.result?.networkId, state.result?.scanId, state.result?.scannedAt]);
      if (signature !== liveSignature) { liveSignature = signature; if (ready && !refreshing) { clearTimeout(timer); timer = setTimeout(refresh, 250); } }
    },
    destroy() { destroyed = true; clearTimeout(timer); replayRequest++; resetComparison(); },
  };
}
