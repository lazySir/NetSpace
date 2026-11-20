export function createDataCleanup(options) {
  const { ui, api, showToast } = options;
  const dialog = ui['data-cleanup-dialog'];
  let networks = [], state = {}, loading = false, saving = false, destroyed = false;
  let generation = 0, dataRevision = null;

  function taskBusy() {
    return Boolean(options.isBooting() || state.maintenance || state.status === 'scanning' ||
      state.deviceCheck?.status === 'checking' || state.webHeaderCheck?.status === 'checking' ||
      state.monitor?.enabled);
  }
  function selectedNetwork() { return networks.find(item => item.id === ui['data-cleanup-network'].value) || null; }
  function render() {
    const selected = selectedNetwork(), locked = taskBusy() || saving || destroyed;
    ui['data-cleanup-open'].disabled = locked || options.isStopped();
    ui['data-cleanup-network'].disabled = locked || loading || !networks.length;
    ui['data-cleanup-confirm'].disabled = locked || !selected;
    ui['data-cleanup-delete'].disabled = locked || loading || !selected || !ui['data-cleanup-confirm'].checked;
    ui['data-cleanup-delete'].textContent = saving ? '正在删除…' : '永久删除所选网络';
    if (loading) ui['data-cleanup-summary'].textContent = '正在读取本机保存的网络和记录数量…';
    else if (!selected) ui['data-cleanup-summary'].textContent = networks.length ? '选择一个网络，查看将删除的记录数量。' : '当前没有可清理的网络记录。';
    else ui['data-cleanup-summary'].textContent =
      '设备档案 ' + selected.deviceCount + ' 条 · 历史快照 ' + selected.scanCount + ' 条 · 网络变化 ' + selected.eventCount + ' 条';
    ui['data-cleanup-message'].textContent = taskBusy()
      ? '请先等待发现、检查或定时任务结束，再清理本地记录。' : '';
    ui['data-cleanup-message'].hidden = !ui['data-cleanup-message'].textContent;
  }

  async function loadCatalogue() {
    const request = ++generation; loading = true; render();
    try {
      const data = await api('/api/data-cleanup');
      if (destroyed || request !== generation) return;
      networks = Array.isArray(data.networks) ? data.networks.filter(item =>
        item && typeof item.id === 'string' && /^[0-9a-f]{32}$/.test(item.id)) : [];
      ui['data-cleanup-network'].replaceChildren();
      const placeholder = document.createElement('option'); placeholder.value = '';
      placeholder.textContent = '选择要清理的网络'; ui['data-cleanup-network'].append(placeholder);
      for (const network of networks) {
        const option = document.createElement('option'); option.value = network.id;
        option.textContent = (network.label || '本地网络') + ' · ' + (network.cidr || '未知网段');
        ui['data-cleanup-network'].append(option);
      }
      ui['data-cleanup-network'].value = '';
      ui['data-cleanup-confirm'].checked = false;
    } catch (error) {
      if (!destroyed && request === generation) {
        networks = []; ui['data-cleanup-network'].replaceChildren();
        const option = document.createElement('option'); option.value = '';
        option.textContent = '暂时无法读取本机记录'; ui['data-cleanup-network'].append(option);
        ui['data-cleanup-message'].textContent = '读取失败：' + error.message;
      }
    } finally {
      if (!destroyed && request === generation) { loading = false; render(); }
    }
  }

  async function open() {
    if (destroyed || options.isStopped() || taskBusy() || saving) return;
    ui['data-cleanup-confirm'].checked = false;
    ui['data-cleanup-message'].textContent = '';
    ui['data-cleanup-message'].hidden = true;
    dialog.showModal();
    await loadCatalogue();
    ui['data-cleanup-network'].focus();
  }

  async function removeSelected() {
    const target = selectedNetwork();
    if (destroyed || saving || taskBusy() || !target || !ui['data-cleanup-confirm'].checked) return;
    const request = ++generation; saving = true; ui['data-cleanup-message'].textContent = ''; render();
    try {
      const result = await api('/api/data-cleanup', { method: 'POST',
        body: JSON.stringify({ networkId: target.id, confirmed: true }) });
      if (destroyed || request !== generation) return;
      if (result.deleted !== true || !Number.isSafeInteger(result.dataRevision) ||
          !result.counts || ['deviceCount', 'scanCount', 'eventCount'].some(key =>
            !Number.isSafeInteger(result.counts[key]) || result.counts[key] < 0))
        throw new Error('本机服务没有确认删除结果，请刷新后核对记录。');
      dialog.close();
      showToast('已删除 ' + target.label + '：设备 ' + result.counts.deviceCount + ' 条、历史 ' +
        result.counts.scanCount + ' 条、变化 ' + result.counts.eventCount + ' 条。');
      await options.onDeleted(target.id, result.dataRevision);
    } catch (error) {
      if (!destroyed) {
        ui['data-cleanup-message'].textContent = '未能完成清理：' + error.message;
        ui['data-cleanup-message'].hidden = false;
        if (error.status === 404) await loadCatalogue();
      }
    } finally {
      if (!destroyed) { saving = false; render(); }
    }
  }

  ui['data-cleanup-open'].addEventListener('click', open);
  ui['data-cleanup-network'].addEventListener('change', () => {
    ui['data-cleanup-confirm'].checked = false; render();
  });
  ui['data-cleanup-confirm'].addEventListener('change', render);
  ui['data-cleanup-delete'].addEventListener('click', removeSelected);
  ui['data-cleanup-close'].addEventListener('click', () => dialog.close());
  ui['data-cleanup-dismiss'].addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close(); });
  dialog.addEventListener('close', () => { ui['data-cleanup-confirm'].checked = false; render(); });

  return {
    observe(value) {
      if (!value) return;
      const nextRevision = Number.isInteger(value.dataRevision) ? value.dataRevision : 0;
      const changed = dataRevision !== null && nextRevision !== dataRevision;
      state = value; dataRevision = nextRevision; render();
      if (changed && dialog.open && !saving) loadCatalogue();
    },
    destroy() { destroyed = true; generation++; render(); },
  };
}
