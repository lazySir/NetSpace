import { deviceIdentity } from '/identity.js';

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

export function buildHistoryComparisonCsv(comparison, metadata) {
  const headers = ['来源', '导出时间', '网络范围', '起始快照时间', '对比快照时间', '变化类型', '设备名称', 'MAC 地址', '稳定记录标识', '起始 IP 地址', '对比 IP 地址', '起始状态', '对比状态', '分组', '备注', '说明'];
  const rows = [headers];
  const name = device => device.profile?.alias || device.hostname || ({ self: '本机', gateway: '默认网关', device: '网络设备' }[device.kind] || '网络设备');
  const status = device => ({ online: '已确认在线', resolved: '已解析 · 在线状态未确认', cached: '缓存记录 · 在线状态未确认', unverified: '待确认' }[device.status] || device.status || '待确认');
  const append = (type, device, oldIp, newIp, oldStatus, newStatus, note = '') => rows.push([
    '历史快照差异', metadata.exportedAt, comparison.target.scope?.cidr || comparison.target.interface?.cidr || '',
    comparison.source.scannedAt, comparison.target.scannedAt, type, name(device), device.mac,
    deviceIdentity(device), oldIp, newIp, oldStatus, newStatus,
    device.profile?.group, device.profile?.notes, note,
  ]);
  for (const device of comparison.added) append('新增', device, '', device.ip, '', status(device));
  for (const item of comparison.changed) append('IP 变化', item.after, item.before.ip, item.after.ip, status(item.before), status(item.after));
  for (const device of comparison.missing) append('本次未见', device, device.ip, '', status(device), '', '本次未见不代表已确认离线');
  return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
