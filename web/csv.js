const FORMULA_PREFIX = /^[\s\0\uFEFF\u200B-\u200F\u202A-\u202E\u2060]*[=+\-@＝＋－＠]/u;

function cell(value) {
  let text = value == null ? '' : String(value);
  if (FORMULA_PREFIX.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

export function buildDeviceCsv(result, devices, metadata) {
  const headers = ['来源', '导出时间', '发现时间', '网络范围', '设备名称', '备注名称', '主机名称', 'IP 地址', 'MAC 地址', '设备类型', '发现状态', '分组', '备注', '已认识', '忽略提醒', '发现依据'];
  const rows = [headers, ...devices.map(device => [
    metadata.source,
    metadata.exportedAt,
    result.scannedAt,
    result.scope?.cidr || result.interface?.cidr || '',
    device.profile?.alias || device.hostname || ({ self: '本机', gateway: '默认网关', device: '网络设备' }[device.kind] || '网络设备'),
    device.profile?.alias,
    device.hostname,
    device.ip,
    device.mac,
    ({ self: '本机', gateway: '默认网关', device: '网络设备' }[device.kind] || device.kind),
    ({ online: '已确认在线', resolved: '已解析 · 在线状态未确认', cached: '缓存记录 · 在线状态未确认', unverified: '待确认' }[device.status] || device.status || '待确认'),
    device.profile?.group,
    device.profile?.notes,
    device.profile?.known ? '是' : '否',
    device.profile?.ignored ? '是' : '否',
    Array.isArray(device.evidence) ? device.evidence.map(item => typeof item === 'string' ? item : String(item?.type || item?.source || '系统记录')).join('；') : '',
  ])];
  return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
