import { buildDeviceCheckReport } from './device-check-report.js';

const PORTS = new Map([[21, 'FTP 文件传输'], [22, 'SSH 远程管理'], [23, 'Telnet 远程管理'], [80, 'HTTP 网页'], [443, 'HTTPS 加密网页'], [445, 'SMB 文件共享'], [3389, 'RDP 远程桌面']]);
const RESULT_LABELS = { open: '可连接', closed: '拒绝连接', no_response: '未响应', unavailable: '不可用' };
const EMPTY = { status: 'idle', completed: 0, total: 7, results: [], networkId: null, deviceKey: null, scanId: null, runId: null };
const validRunId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);

// The server resolves a saved device identifier. The browser never supplies a target address or port.
export function createDeviceCheck({ ui, api, readContext, rerender }) {
  let state = { ...EMPTY }, target = null, selection = '', timer = null;
  let starting = false, cancelling = false, destroyed = false, ownRun = false;
  let viewGeneration = 0, taskGeneration = 0, error = '', resultSignature = '', exportNotice = '';
  const dialog = ui['device-check-dialog'];
  function text(id, value) { if (ui[id].textContent !== value) ui[id].textContent = value; }

  function context() {
    const current = readContext();
    const result = current.result, device = current.device;
    const identity = result && device ? JSON.stringify([result.networkId, result.scanId, result.scannedAt, device.deviceKey, device.ip]) : '';
    const age = Date.now() - new Date(result?.scannedAt).getTime();
    let reason = '', expiryOnly = false;
    if (current.stopped) reason = '本机服务已停止，重新打开程序后再检查。';
    else if (current.demo) reason = '演示设备是虚构数据，不能执行真实检查。';
    else if (current.historical) reason = '历史快照仅供查看，请返回当前网络。';
    else if (current.booting) reason = '正在连接本机服务，请稍候。';
    else if (current.scanning) reason = '正在发现设备，完成后才能开始检查。';
    else if (!result?.networkId || !Number.isSafeInteger(result.scanId) || result.scanId <= 0 || !device?.deviceKey || !current.current) reason = '请先在当前网络发现设备，再选择一台其他设备。';
    else if (device.kind === 'self') reason = '这里检查其他设备，请在列表中选择路由器或另一台设备。';
    else if (!Number.isFinite(age) || age < -30000 || age > 300000) { reason = '设备记录已超过 5 分钟，请重新发现设备后再检查。'; expiryOnly = true; }
    const matches = Boolean(device?.deviceKey && result?.networkId && Number.isSafeInteger(result.scanId) && result.scanId > 0 && state.networkId === result.networkId && state.deviceKey === device.deviceKey && state.scanId === result.scanId);
    if (!reason && state.status === 'checking' && !matches) reason = '另一台设备正在检查，请等待本次检查结束。';
    const viewReason = expiryOnly && matches && state.status !== 'idle' ? '' : reason;
    return { ...current, identity, reason, viewReason, matches };
  }
  function close() {
    viewGeneration++; target = null; error = ''; exportNotice = '';
    ui['device-check-consent'].checked = false;
    if (dialog.open) dialog.close();
  }
  function sync() {
    if (destroyed) return;
    const current = context();
    if (current.stopped) clearTimeout(timer);
    if (current.identity !== selection) { selection = current.identity; close(); }
    if (dialog.open && (current.viewReason || target?.identity !== current.identity)) close();
    ui['device-check-open'].disabled = Boolean(current.viewReason) || starting;
    text('device-check-open', current.matches && state.status === 'checking' ? '查看检查进度' : current.matches && state.status !== 'idle' ? '查看上次检查结果' : '了解并检查');
    text('device-check-availability', current.reason && !current.viewReason ? '可查看本次结果；开始新的检查前，请重新发现设备。' : current.reason || '只检查你主动选择的这一台；不会自动运行。');
    const matching = Boolean(target && current.matches && target.networkId === state.networkId && target.deviceKey === state.deviceKey && target.scanId === state.scanId);
    const checking = matching && state.status === 'checking';
    ui['device-check-consent'].disabled = Boolean(current.reason) || starting || checking || cancelling || !target;
    ui['device-check-start'].disabled = Boolean(current.reason) || !target || !ui['device-check-consent'].checked || starting || checking || cancelling || state.status === 'checking';
    ui['device-check-start'].textContent = starting ? '正在开始…' : '开始检查这台设备';
    ui['device-check-cancel'].disabled = !checking || !validRunId(state.runId) || starting || cancelling;
    ui['device-check-cancel'].textContent = cancelling ? '正在停止…' : '停止本次检查';
    text('device-check-error', error); ui['device-check-error'].hidden = !error;
    const completed = matching ? Math.max(0, Math.min(7, Number(state.completed) || 0)) : 0;
    ui['device-check-progress'].hidden = !matching || state.status === 'idle';
    ui['device-check-progress'].value = completed;
    text('device-check-status', starting ? '正在请求开始检查…' : cancelling ? '正在停止；已完成的观察结果会保留。' : checking ? '正在检查：' + completed + ' / 7。关闭窗口不会停止检查。'
      : matching && state.status === 'complete' ? '检查完成：' + completed + ' / 7。以下是本次连接观察，不是漏洞诊断。'
        : matching && state.status === 'cancelled' ? '已取消。已完成 ' + completed + ' / 7，其余端口未检查。'
          : matching && state.status === 'error' ? '检查未完成，请确认设备记录仍有效后重试。'
            : '阅读说明并勾选授权后，再点击开始。');
    const results = matching && Array.isArray(state.results) ? state.results : [];
    const rows = [];
    for (const [port, label] of PORTS) {
      const result = results.find(item => item && item.port === port && Object.hasOwn(RESULT_LABELS, item.status));
      if (result) rows.push([port, label, result.status]);
    }
    ui['device-check-export'].disabled = Boolean(current.viewReason) || !matching || starting || cancelling || !['complete', 'cancelled', 'error'].includes(state.status) || !rows.length;
    text('device-check-export-status', exportNotice);
    const signature = JSON.stringify(rows);
    if (resultSignature === signature) return;
    resultSignature = signature; ui['device-check-results'].replaceChildren();
    for (const [port, label, status] of rows) {
      const row = document.createElement('li'); row.dataset.result = status;
      const name = document.createElement('span'); name.className = 'device-check-service'; name.textContent = label;
      const number = document.createElement('span'); number.className = 'device-check-port mono'; number.textContent = 'TCP ' + port;
      const outcome = document.createElement('strong'); outcome.textContent = RESULT_LABELS[status];
      row.append(name, number, outcome); ui['device-check-results'].append(row);
    }
  }
  function update(value) {
    if (!value || !['idle', 'checking', 'complete', 'cancelled', 'error'].includes(value.status)) throw new Error('检查状态暂时无法读取，请重新打开检查窗口。');
    state = { ...EMPTY, ...value };
    if (state.status !== 'checking') { ownRun = false; cancelling = false; }
    sync(); rerender(); schedule();
  }
  function schedule() {
    clearTimeout(timer);
    if (!destroyed && !cancelling && !readContext().stopped && state.status === 'checking') timer = setTimeout(poll, 450);
  }
  async function poll() {
    if (destroyed || cancelling || readContext().stopped || state.status !== 'checking') return;
    const generation = taskGeneration, runId = state.runId;
    try {
      const value = await api('/api/device-check');
      if (!destroyed && generation === taskGeneration && runId === state.runId && !starting && !cancelling) update(value);
    } catch (failure) {
      if (destroyed || generation !== taskGeneration || runId !== state.runId || cancelling) return;
      if (dialog.open) { error = '暂时无法读取进度：' + failure.message + ' 可关闭窗口后重新查看。'; sync(); }
      clearTimeout(timer); timer = setTimeout(poll, 2000);
    }
  }
  async function start() {
    const current = context();
    if (destroyed || starting || state.status === 'checking' || current.reason || !target || target.identity !== current.identity || !ui['device-check-consent'].checked) return;
    const selected = { ...target }, view = viewGeneration, generation = ++taskGeneration;
    starting = true; ownRun = true; state = { ...EMPTY }; error = ''; exportNotice = ''; ui['device-check-consent'].checked = false; sync(); rerender();
    try {
      const response = await api('/api/device-check', { method: 'POST', body: JSON.stringify({ networkId: selected.networkId, deviceKey: selected.deviceKey, scanId: selected.scanId, authorized: true }) });
      if (!destroyed && generation === taskGeneration) update(response);
    } catch (failure) {
      if (!destroyed && generation === taskGeneration) {
        ownRun = false;
        if (view === viewGeneration && target?.identity === selected.identity) error = failure.message;
      }
    } finally {
      if (!destroyed && generation === taskGeneration) { starting = false; sync(); rerender(); schedule(); }
    }
  }
  async function cancel() {
    const current = context();
    if (destroyed || starting || cancelling || !target || !current.matches || state.status !== 'checking' || !validRunId(state.runId)) return;
    const view = viewGeneration, generation = ++taskGeneration, runId = state.runId; cancelling = true; clearTimeout(timer); error = ''; sync();
    try {
      await api('/api/device-check/cancel', { method: 'POST', body: JSON.stringify({ runId }) });
      if (!destroyed && generation === taskGeneration) {
        const refreshed = await api('/api/device-check');
        if (!destroyed && generation === taskGeneration) update(refreshed);
      }
    } catch (failure) { if (!destroyed && generation === taskGeneration && view === viewGeneration) error = '未能停止：' + failure.message; }
    finally { if (!destroyed && generation === taskGeneration) { cancelling = false; sync(); schedule(); } }
  }
  function exportReport() {
    const current = context();
    if (destroyed || starting || cancelling || current.viewReason || !target || target.identity !== current.identity || !current.matches) return;
    let url;
    try {
      const exportedAt = new Date();
      const report = buildDeviceCheckReport({ result: current.result, device: current.device, check: state, exportedAt: exportedAt.toISOString() });
      url = URL.createObjectURL(new Blob([report], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url; link.download = 'NetSpace-service-check-' + exportedAt.toISOString().replace(/[:.]/g, '-') + '.txt';
      document.body.append(link);
      try { link.click(); } finally { link.remove(); }
      exportNotice = '已生成报告，请在浏览器下载列表中查看。';
    } catch { exportNotice = '暂时无法生成报告，请确认当前设备已有检查结果后重试。'; }
    finally { if (url) setTimeout(() => URL.revokeObjectURL(url), 1000); }
    sync();
  }
  ui['device-check-open'].addEventListener('click', () => {
    const current = context(); if (current.viewReason || starting || destroyed) return;
    viewGeneration++; error = ''; ui['device-check-consent'].checked = false;
    target = { identity: current.identity, networkId: current.result.networkId, deviceKey: current.device.deviceKey, scanId: current.result.scanId };
    ui['device-check-target-name'].textContent = current.device.profile?.alias || current.device.hostname || '网络设备';
    ui['device-check-target-ip'].textContent = current.device.ip;
    dialog.showModal(); sync();
  });
  ui['device-check-consent'].addEventListener('change', sync);
  ui['device-check-start'].addEventListener('click', start);
  ui['device-check-cancel'].addEventListener('click', cancel);
  ui['device-check-export'].addEventListener('click', exportReport);
  ui['device-check-close'].addEventListener('click', close);
  ui['device-check-dismiss'].addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('close', () => { ui['device-check-consent'].checked = false; });
  const freshnessTimer = setInterval(sync, 1000);
  return {
    sync,
    get busy() { return starting || state.status === 'checking'; },
    snapshot() { return { ...state, results: Array.isArray(state.results) ? state.results.map(item => ({ ...item })) : [] }; },
    observe(value) { if (!ownRun && !starting && value) { try { update(value); } catch {} } },
    destroy() { destroyed = true; taskGeneration++; close(); clearTimeout(timer); clearInterval(freshnessTimer); },
  };
}
