const EMPTY = { status: 'idle', completed: 0, total: 0, results: [], networkId: null, deviceKey: null, scanId: null, runId: null };
const validRunId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const PORT_LABELS = new Map([[80, 'HTTP 网页'], [443, 'HTTPS 加密网页']]);
const CHECK_LABELS = new Map([
  ['csp', '内容安全策略'], ['nosniff', '文件类型保护'], ['referrer', '来源信息保护'],
  ['permissions', '浏览器功能限制'], ['hsts', 'HTTPS 强制传输'],
]);
const STATUS_LABELS = { complete: '已收到响应', unavailable: '无法完成', redirect_blocked: '已停止跳转', present: '存在', missing: '缺少', unavailable_check: '未能判断' };
const EMPTY_SERVICE = { status: 'idle', completed: 0, total: 0, results: [], networkId: null, deviceKey: null, scanId: null };

export function createWebHeaderCheck({ ui, api, readContext, rerender }) {
  let state = { ...EMPTY }, target = null, selection = '', timer = null;
  let starting = false, cancelling = false, destroyed = false, ownRun = false;
  let viewGeneration = 0, taskGeneration = 0, error = '', resultSignature = '';
  const dialog = ui['web-header-check-dialog'];
  function setText(id, value) { if (ui[id].textContent !== value) ui[id].textContent = value; }

  function context() {
    const current = readContext(), result = current.result, device = current.device;
    const identity = result && device ? JSON.stringify([result.networkId, result.scanId, result.scannedAt, device.deviceKey, device.ip]) : '';
    const age = Date.now() - new Date(result?.scannedAt).getTime();
    const service = current.serviceCheck || EMPTY_SERVICE;
    const serviceMatches = service.status === 'complete' && service.completed === service.total &&
      service.networkId === result?.networkId && service.deviceKey === device?.deviceKey && service.scanId === result?.scanId;
    const ports = serviceMatches && Array.isArray(service.results)
      ? [...new Set(service.results.filter(item => item && item.status === 'open' && PORT_LABELS.has(item.port)).map(item => item.port))].sort((a, b) => a - b) : [];
    let reason = '';
    if (current.stopped) reason = '本机服务已停止，重新打开程序后再检查。';
    else if (current.demo) reason = '演示设备是虚构数据，不能执行真实检查。';
    else if (current.historical) reason = '历史快照仅供查看，请返回当前网络。';
    else if (current.booting) reason = '正在连接本机服务，请稍候。';
    else if (current.scanning) reason = '正在发现设备，完成后才能开始检查。';
    else if (!result?.networkId || !Number.isSafeInteger(result.scanId) || result.scanId <= 0 || !device?.deviceKey || !current.current) reason = '请先在当前网络发现设备，再选择一台其他设备。';
    else if (device.kind === 'self') reason = '这里检查其他设备，请选择路由器或另一台设备。';
    else if (!Number.isFinite(age) || age < -30000 || age > 300000) reason = '设备记录已超过 5 分钟，请重新发现设备后再检查。';
    else if (!serviceMatches) reason = '请先完成这台设备本次发现结果对应的服务检查。';
    else if (!ports.length) reason = '本次服务检查没有确认开放的 HTTP 或 HTTPS 端口。';
    const matches = Boolean(device?.deviceKey && result?.networkId && Number.isSafeInteger(result.scanId) && result.scanId > 0 &&
      state.networkId === result.networkId && state.deviceKey === device.deviceKey && state.scanId === result.scanId);
    if (!reason && state.status === 'checking' && !matches) reason = '另一台设备正在检查，请等待本次检查结束。';
    return { ...current, identity, reason, matches, ports };
  }
  function close() {
    viewGeneration++; target = null; error = '';
    ui['web-header-check-consent'].checked = false;
    if (dialog.open) dialog.close();
  }
  function sync() {
    if (destroyed) return;
    const current = context();
    if (current.stopped) clearTimeout(timer);
    if (current.identity !== selection) { selection = current.identity; close(); }
    if (dialog.open && (current.reason || target?.identity !== current.identity)) close();
    ui['web-header-check-open'].disabled = Boolean(current.reason) || starting;
    setText('web-header-check-availability', current.reason || '最多检查：' + current.ports.map(port => PORT_LABELS.get(port)).join('、') + '。只查看响应头名称。');
    const matching = Boolean(target && current.matches && target.networkId === state.networkId && target.deviceKey === state.deviceKey && target.scanId === state.scanId);
    const checking = matching && state.status === 'checking';
    ui['web-header-check-consent'].disabled = Boolean(current.reason) || starting || checking || cancelling || !target;
    ui['web-header-check-start'].disabled = Boolean(current.reason) || !target || !ui['web-header-check-consent'].checked || starting || checking || cancelling || state.status === 'checking';
    ui['web-header-check-start'].textContent = starting ? '正在开始…' : '发送请求并检查';
    ui['web-header-check-cancel'].disabled = !checking || !validRunId(state.runId) || starting || cancelling;
    ui['web-header-check-cancel'].textContent = cancelling ? '正在停止…' : '停止本次检查';
    setText('web-header-check-error', error); ui['web-header-check-error'].hidden = !error;
    const completed = matching ? Math.max(0, Math.min(2, Number(state.completed) || 0)) : 0;
    ui['web-header-check-progress'].max = Math.max(1, matching ? Number(state.total) || 0 : current.ports.length || 1);
    ui['web-header-check-progress'].hidden = !matching || state.status === 'idle';
    ui['web-header-check-progress'].value = completed;
    setText('web-header-check-status', starting ? '正在请求开始检查…' : cancelling ? '正在停止；已完成的观察结果会保留。' : checking ? '正在检查：' + completed + ' / ' + state.total + '。关闭窗口不会停止检查。'
      : matching && state.status === 'complete' ? '检查完成：' + completed + ' / ' + state.total + '。这是有限的响应头观察，不是漏洞诊断。'
        : matching && state.status === 'cancelled' ? '已取消。已完成 ' + completed + ' / ' + state.total + '，其余端口未检查。'
          : matching && state.status === 'error' ? '检查未完成，请确认设备记录仍有效后重试。'
            : '阅读说明并勾选授权后，再点击开始。');
    const results = matching && Array.isArray(state.results) ? state.results : [];
    const safeRows = results.filter(item => item && PORT_LABELS.has(item.port) && ['complete', 'unavailable', 'redirect_blocked'].includes(item.status))
      .map(item => [item.port, item.status, (Array.isArray(item.checks) ? item.checks : []).filter(check => CHECK_LABELS.has(check.id))
        .map(check => [check.id, ['present', 'missing'].includes(check.status) ? check.status : 'unavailable_check'])]);
    const signature = JSON.stringify(safeRows);
    if (resultSignature !== signature) {
      resultSignature = signature; ui['web-header-check-results'].replaceChildren();
      for (const [port, status, checks] of safeRows) {
        const row = document.createElement('li'); row.dataset.result = status;
        const name = document.createElement('span'); name.className = 'device-check-service'; name.textContent = PORT_LABELS.get(port);
        const number = document.createElement('span'); number.className = 'device-check-port mono'; number.textContent = 'TCP ' + port;
        const outcome = document.createElement('strong'); outcome.textContent = STATUS_LABELS[status];
        row.append(name, number, outcome);
        if (checks.length) {
          const summary = document.createElement('span'); summary.className = 'web-header-check-findings';
          summary.textContent = checks.map(([id, value]) => CHECK_LABELS.get(id) + '：' + STATUS_LABELS[value]).join(' · ');
          row.append(summary);
        }
        ui['web-header-check-results'].append(row);
      }
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
      const value = await api('/api/web-header-check');
      if (!destroyed && generation === taskGeneration && runId === state.runId && !starting && !cancelling) update(value);
    } catch (failure) {
      if (destroyed || generation !== taskGeneration || runId !== state.runId || cancelling) return;
      if (dialog.open) { error = '暂时无法读取进度：' + failure.message + ' 可关闭窗口后重新查看。'; sync(); }
      clearTimeout(timer); timer = setTimeout(poll, 2000);
    }
  }
  async function start() {
    const current = context();
    if (destroyed || starting || state.status === 'checking' || current.reason || !target || target.identity !== current.identity || !ui['web-header-check-consent'].checked) return;
    const selected = { ...target }, view = viewGeneration, generation = ++taskGeneration;
    starting = true; ownRun = true; state = { ...EMPTY }; error = ''; ui['web-header-check-consent'].checked = false; sync(); rerender();
    try {
      const response = await api('/api/web-header-check', { method: 'POST', body: JSON.stringify({ networkId: selected.networkId, deviceKey: selected.deviceKey, scanId: selected.scanId, authorized: true }) });
      if (!destroyed && generation === taskGeneration) update(response);
    } catch (failure) {
      if (!destroyed && generation === taskGeneration && view === viewGeneration && target?.identity === selected.identity) error = failure.message;
    } finally {
      if (!destroyed && generation === taskGeneration) { starting = false; sync(); rerender(); schedule(); }
    }
  }
  async function cancel() {
    const current = context();
    if (destroyed || starting || cancelling || !target || !current.matches || state.status !== 'checking' || !validRunId(state.runId)) return;
    const view = viewGeneration, generation = ++taskGeneration, runId = state.runId; cancelling = true; clearTimeout(timer); error = ''; sync();
    try {
      await api('/api/web-header-check/cancel', { method: 'POST', body: JSON.stringify({ runId }) });
      if (!destroyed && generation === taskGeneration) {
        const refreshed = await api('/api/web-header-check');
        if (!destroyed && generation === taskGeneration) update(refreshed);
      }
    } catch (failure) { if (!destroyed && generation === taskGeneration && view === viewGeneration) error = '未能停止：' + failure.message; }
    finally { if (!destroyed && generation === taskGeneration) { cancelling = false; sync(); schedule(); } }
  }
  ui['web-header-check-open'].addEventListener('click', () => {
    const current = context(); if (current.reason || starting || destroyed) return;
    viewGeneration++; error = ''; ui['web-header-check-consent'].checked = false;
    target = { identity: current.identity, networkId: current.result.networkId, deviceKey: current.device.deviceKey, scanId: current.result.scanId, ports: current.ports };
    ui['web-header-check-target-name'].textContent = current.device.profile?.alias || current.device.hostname || '网络设备';
    ui['web-header-check-target-ip'].textContent = current.device.ip;
    ui['web-header-check-ports'].textContent = current.ports.map(port => PORT_LABELS.get(port) + '（TCP ' + port + '）').join(' · ');
    dialog.showModal(); sync();
  });
  ui['web-header-check-consent'].addEventListener('change', sync);
  ui['web-header-check-start'].addEventListener('click', start);
  ui['web-header-check-cancel'].addEventListener('click', cancel);
  ui['web-header-check-close'].addEventListener('click', close);
  ui['web-header-check-dismiss'].addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('close', () => { ui['web-header-check-consent'].checked = false; });
  const freshnessTimer = setInterval(sync, 1000);
  return {
    sync,
    get busy() { return starting || state.status === 'checking'; },
    observe(value) { if (!ownRun && !starting && value) { try { update(value); } catch {} } },
    destroy() { destroyed = true; taskGeneration++; close(); clearTimeout(timer); clearInterval(freshnessTimer); },
  };
}
