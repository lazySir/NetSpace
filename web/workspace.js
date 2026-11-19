const EMPTY_PROFILE = { alias: '', notes: '', group: '', known: false, ignored: false };
const EVENT_LABELS = { new: '新设备', returned: '再次发现', not_seen: '本次未见', ip_changed: 'IP 已变化' };

// Persistent records belong to the server; view modes and unsaved drafts stay local.
export function createWorkspace(options) {
  const { ui, api, rerender, showToast } = options;
  let monitor = { enabled: false, interfaceId: null, intervalSeconds: 300, nextScanAt: null, error: null, notificationsEnabled: true };
  let ready = false, busy = false, destroyed = false, refreshing = false, timer = null, settingsGeneration = 0;
  let replay = null, replayRequest = 0, networkId = '', pinnedNetwork = false, tab = 'devices';
  let networks = [], scans = [], events = [], records = [];
  let unreadCount = 0, archiveError = '', monitorError = '', loadingReplay = false;
  let networkSignature = '', historySignature = '', eventSignature = '', liveSignature = '';
  const drafts = new Map(), notifiedEvents = new Set();
  let profileKey = '';

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
    const signature = JSON.stringify([networkId, scans]);
    if (signature !== historySignature) {
      historySignature = signature; ui['history-scan'].replaceChildren();
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = scans.length ? '选择发现记录，查看当时设备' : '该网络尚无历史记录'; ui['history-scan'].append(placeholder);
      for (const scan of scans) {
        const option = document.createElement('option'); option.value = String(scan.id);
        option.textContent = stamp(scan.scannedAt) + ' · ' + scan.deviceCount + ' 台 · ' + Number(scan.changeCount || 0) + ' 项变化';
        ui['history-scan'].append(option);
      }
    }
    ui['history-scan'].disabled = !scans.length || options.isStopped() || loadingReplay || options.isDemo();
    ui['history-scan'].value = replay && replay.networkId === networkId ? String(replay.scanId) : '';
    ui['replay-banner'].hidden = !replay || options.isDemo();
    ui['replay-description'].textContent = replay ? stamp(replay.scannedAt) + ' · ' + (replay.interface?.cidr || '') + ' · 仅供查看' : '';
    message(ui['archive-message'], loadingReplay ? '正在读取历史快照…' : archiveError);
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
    for (const event of fresh) notifiedEvents.add(event.id);
    showToast('发现 ' + fresh.length + ' 台新设备，请查看“变化”记录。');
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
      if (!pinnedNetwork && liveId && networks.some(item => item.id === liveId)) networkId = liveId;
      else if (!networks.some(item => item.id === networkId)) networkId = networks[0]?.id || '';
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
  ui['network-filter'].addEventListener('change', () => {
    networkId = ui['network-filter'].value; pinnedNetwork = true; replayRequest++; replay = null; loadingReplay = false;
    scans = []; events = []; records = []; unreadCount = 0; archiveError = ''; rerender(); loadNetworkRecords();
  });
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
    destroy() { destroyed = true; clearTimeout(timer); replayRequest++; },
  };
}
