import { createArchiveIndex } from '/archive-search.js';

const PAGE_SIZE = 50;
const KINDS = { self: '本机', gateway: '默认网关', device: '网络设备' };

// Saved records have their own view. They never become live discovery or check targets.
export function createDeviceArchive(options) {
  const { ui, api } = options;
  const dialog = ui['device-archive-dialog'];
  let networks = [], records = [], index = null, shown = PAGE_SIZE;
  let generation = 0, dataRevision = null, searchTimer = null;
  let loadingCatalogue = false, loadingRecords = false, error = '', destroyed = false;

  function unavailable() { return destroyed || options.isBooting() || options.isStopped() || options.isDemo(); }
  function busy() { return loadingCatalogue || loadingRecords; }
  function resetSearch() {
    clearTimeout(searchTimer); shown = PAGE_SIZE;
    ui['archive-search'].value = ''; ui['archive-filter'].value = 'all';
  }
  function clearRecords() { records = []; index = null; shown = PAGE_SIZE; }
  function currentRequest(request) { return !destroyed && dialog.open && request === generation && !unavailable(); }
  function stamp(value) {
    const date = new Date(value);
    return value && Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }) : '未记录';
  }
  function node(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value != null) element.textContent = value;
    return element;
  }
  function card(device) {
    const profile = device.profile || {};
    const item = node('li', 'archive-device-card'); item.dataset.deviceKey = device.deviceKey;
    const heading = node('div', 'archive-device-heading');
    heading.append(node('h3', 'archive-device-name', profile.alias || device.hostname || KINDS[device.kind] || '网络设备'));
    const presence = node('span', 'archive-presence', device.present === false ? '最近一次未见' : device.present === true ? '最近一次有记录' : '最近发现状态未记录');
    presence.dataset.presence = device.present === false ? 'missing' : 'recorded';
    heading.append(presence); item.append(heading);
    const tags = node('p', 'archive-device-tags');
    tags.append(node('span', '', KINDS[device.kind] || '网络设备'));
    if (profile.known === true) tags.append(node('span', '', '已认识'));
    if (profile.ignored === true) tags.append(node('span', '', '已忽略提醒'));
    if (device.kind !== 'self' && profile.known !== true && profile.ignored !== true) tags.append(node('span', 'archive-review', '待复核'));
    item.append(tags);
    const facts = node('dl', 'archive-device-facts');
    const values = [
      ['最近地址', device.ip || '未记录', true], ['MAC', device.mac || '未解析', true],
      ['分组', profile.group || '未分组'], ['主机名称', device.hostname || '未获取'],
      ['首次发现', stamp(device.firstSeen)], ['最近发现', stamp(device.lastSeen)],
    ];
    for (const [label, value, mono] of values) {
      const fact = node('div'); fact.append(node('dt', '', label), node('dd', mono ? 'mono' : '', value)); facts.append(fact);
    }
    item.append(facts);
    if (profile.notes) {
      const notes = node('details', 'archive-device-notes');
      notes.append(node('summary', '', '查看已保存备注'), node('p', '', profile.notes)); item.append(notes);
    }
    return item;
  }
  function controls() {
    const locked = unavailable();
    ui['archive-open'].disabled = locked;
    ui['archive-open'].title = options.isDemo() ? '退出演示后可查看本机保存的真实设备档案' : '只读取本机保存的档案，不会开始发现';
    ui['archive-network'].disabled = locked || loadingCatalogue || !networks.length;
    ui['archive-refresh'].disabled = locked || busy();
    ui['archive-search'].disabled = locked || busy() || !records.length;
    ui['archive-filter'].disabled = locked || busy() || !records.length;
    ui['archive-error'].textContent = error; ui['archive-error'].hidden = !error;
    ui['archive-list'].setAttribute('aria-busy', String(busy()));
  }
  function renderResults() {
    controls();
    const matches = index ? index.search(ui['archive-search'].value, ui['archive-filter'].value) : [];
    const missing = records.filter(device => device.present === false).length;
    const review = records.filter(device => device.kind !== 'self' && device.profile?.known !== true && device.profile?.ignored !== true).length;
    ui['archive-summary'].textContent = loadingCatalogue ? '正在读取本机保存的网络…'
      : loadingRecords ? '正在读取所选网络的设备档案…'
        : '共 ' + records.length + ' 条档案 · 最近一次未见 ' + missing + ' 条 · 待复核 ' + review + ' 条；匹配 ' + matches.length + ' 条，已显示 ' + Math.min(shown, matches.length) + ' 条。';
    ui['archive-list'].replaceChildren(...matches.slice(0, shown).map(card));
    ui['archive-more'].hidden = busy() || shown >= matches.length;
    ui['archive-more'].textContent = '再显示 ' + Math.min(PAGE_SIZE, Math.max(0, matches.length - shown)) + ' 条';
    ui['archive-empty'].hidden = busy() || Boolean(matches.length) || Boolean(error);
    ui['archive-empty'].textContent = !networks.length ? '尚无已保存的网络。返回主界面，手动发现一次设备后再来查看。'
      : !records.length ? '这个网络尚无设备档案。可返回主界面，手动发现设备后刷新本地记录。'
        : '没有匹配的设备档案。调整关键词或筛选条件后再试。';
  }
  async function loadDevices() {
    const networkId = ui['archive-network'].value;
    const request = ++generation; clearRecords(); resetSearch(); error = '';
    loadingRecords = Boolean(networkId); renderResults();
    if (!networkId || unavailable()) { loadingRecords = false; return; }
    try {
      const data = await api('/api/devices?networkId=' + encodeURIComponent(networkId));
      if (!currentRequest(request)) return;
      if (!Array.isArray(data.devices) || data.devices.some(device => !device || typeof device !== 'object' || typeof device.deviceKey !== 'string' || !device.deviceKey))
        throw new Error('本机设备档案格式无法识别，请刷新后重试。');
      records = data.devices; index = createArchiveIndex(records);
    } catch (failure) {
      if (currentRequest(request)) { clearRecords(); error = '读取设备档案失败：' + failure.message; }
    } finally {
      if (currentRequest(request)) { loadingRecords = false; renderResults(); }
    }
  }
  async function loadCatalogue(preferred = ui['archive-network'].value) {
    const request = ++generation; loadingCatalogue = true; loadingRecords = false;
    networks = []; clearRecords(); resetSearch(); error = '';
    ui['archive-network'].replaceChildren(node('option', '', '正在读取本地网络…')); renderResults();
    try {
      const data = await api('/api/networks');
      if (!currentRequest(request)) return;
      if (!Array.isArray(data.networks) || data.networks.some(network => !network || typeof network.id !== 'string' || !network.id))
        throw new Error('本机网络记录格式无法识别，请重试。');
      networks = data.networks; ui['archive-network'].replaceChildren();
      for (const network of networks) {
        const option = node('option', '', (network.label || '本地网络') + ' · ' + (network.cidr || '未知网段'));
        option.value = network.id; ui['archive-network'].append(option);
      }
      if (!networks.length) {
        const empty = node('option', '', '尚无已保存的网络'); empty.value = ''; ui['archive-network'].append(empty);
      }
      ui['archive-network'].value = networks.some(network => network.id === preferred) ? preferred : networks[0]?.id || '';
      loadingCatalogue = false;
      await loadDevices();
    } catch (failure) {
      if (currentRequest(request)) {
        networks = []; clearRecords(); error = '读取本地网络失败：' + failure.message;
        const empty = node('option', '', '暂时无法读取本地网络'); empty.value = ''; ui['archive-network'].replaceChildren(empty);
      }
    } finally {
      if (currentRequest(request)) { loadingCatalogue = false; renderResults(); }
    }
  }
  function close() { if (dialog.open) dialog.close(); }
  function invalidate() {
    generation++; clearTimeout(searchTimer); loadingCatalogue = false; loadingRecords = false;
    networks = []; clearRecords(); resetSearch(); error = '';
    ui['archive-network'].replaceChildren(); renderResults();
  }
  ui['archive-open'].addEventListener('click', () => {
    if (unavailable()) return;
    dialog.showModal(); loadCatalogue(options.getNetworkId() || '');
  });
  ui['archive-network'].addEventListener('change', loadDevices);
  ui['archive-refresh'].addEventListener('click', () => { if (!unavailable() && !busy()) loadCatalogue(); });
  ui['archive-search'].addEventListener('input', () => {
    clearTimeout(searchTimer); searchTimer = setTimeout(() => { shown = PAGE_SIZE; renderResults(); }, 120);
  });
  ui['archive-filter'].addEventListener('change', () => { clearTimeout(searchTimer); shown = PAGE_SIZE; renderResults(); });
  ui['archive-more'].addEventListener('click', () => { shown += PAGE_SIZE; renderResults(); });
  ui['archive-close'].addEventListener('click', close);
  ui['archive-dismiss'].addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('close', invalidate);
  return {
    observe(state) {
      const revision = Number.isSafeInteger(state?.dataRevision) && state.dataRevision >= 0 ? state.dataRevision : 0;
      const changed = dataRevision !== null && revision !== dataRevision; dataRevision = revision;
      if (unavailable() && dialog.open) close();
      if (changed) { const selected = ui['archive-network'].value; invalidate(); if (dialog.open && !unavailable()) loadCatalogue(selected); }
      controls();
    },
    destroy() { destroyed = true; close(); invalidate(); },
  };
}
