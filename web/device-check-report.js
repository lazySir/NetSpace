const PORTS = new Map([[21, 'FTP 文件传输'], [22, 'SSH 远程管理'], [23, 'Telnet 远程管理'], [80, 'HTTP 网页'], [443, 'HTTPS 加密网页'], [445, 'SMB 文件共享'], [3389, 'RDP 远程桌面']]);
const OBSERVATIONS = { open: '可连接', closed: '拒绝连接', no_response: '未响应', unavailable: '不可用' };
const TASKS = { complete: '已完成', cancelled: '已取消', error: '检查未完成' };
const CRLF = String.fromCharCode(13, 10);
const BOM = String.fromCharCode(0xFEFF);

function nonempty(value) { return typeof value === 'string' && value.trim().length > 0; }
function singleLine(value, limit = 160) {
  if (typeof value !== 'string') return '';
  const cleaned = Array.from(value, character => {
    const code = character.codePointAt(0);
    return code <= 0x1F || (code >= 0x7F && code <= 0x9F) || code === 0x061C || code === 0x180E
      || (code >= 0x200B && code <= 0x200F) || (code >= 0x2028 && code <= 0x202E)
      || (code >= 0x2060 && code <= 0x206F) || code === 0xFEFF ? ' ' : character;
  }).join('');
  return Array.from(cleaned.replace(/ +/g, ' ').trim()).slice(0, limit).join('');
}
function timestamp(value) {
  // Accept only an explicit ISO timestamp: permissive Date parsing can interpret hostile text as a year.
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(value)) return '未记录';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '未记录';
}

// This only formats observations already held in memory; it has no network or clock access.
export function buildDeviceCheckReport({ result, device, check, exportedAt } = {}) {
  if (!result || !device || !check || !nonempty(result.networkId) || !nonempty(device.deviceKey)
      || !nonempty(device.ip) || !Number.isSafeInteger(result.scanId) || result.scanId <= 0
      || result.networkId !== check.networkId || device.deviceKey !== check.deviceKey
      || result.scanId !== check.scanId || !Array.isArray(result.devices)) {
    throw new Error('检查结果与当前网络、设备或发现记录不匹配。');
  }
  const peer = result.devices.find(item => item && item.deviceKey === device.deviceKey && item.ip === device.ip);
  if (!peer || device.kind === 'self' || peer.kind === 'self') throw new Error('检查结果没有对应的其他设备。');
  if (!Object.hasOwn(TASKS, check.status)) throw new Error('检查尚未完成，没有可导出的结果。');
  if (!Array.isArray(check.results) || !check.results.length) throw new Error('没有可导出的端口检查结果。');

  const rows = new Map();
  for (const row of check.results) {
    if (!row || !PORTS.has(row.port) || !Object.hasOwn(OBSERVATIONS, row.status) || rows.has(row.port)) {
      throw new Error('端口检查结果无效，请重新查看本次检查。');
    }
    rows.set(row.port, OBSERVATIONS[row.status]);
  }
  if (check.status === 'complete' && rows.size !== PORTS.size) throw new Error('已完成的检查结果不完整。');

  const name = singleLine(peer.profile?.alias) || singleLine(peer.hostname) || '网络设备';
  const lines = [
    'NetSpace 服务检查报告',
    '',
    '设备名称：' + name,
    'IP 地址：' + singleLine(peer.ip, 80),
    '发现时间（不是检查时间）：' + timestamp(result.scannedAt),
    '报告生成时间（不是检查时间）：' + timestamp(exportedAt),
    '任务状态：' + TASKS[check.status],
    '已检查端口：' + rows.size + ' / ' + PORTS.size,
    '',
    '本次观察',
    ...Array.from(PORTS, ([port, service]) => 'TCP ' + port + ' · ' + service + ' · ' + (rows.get(port) || '未检查')),
    '',
    '如何理解',
    '可连接：该端口接受了本次 TCP 连接，不等于存在漏洞，也不能证明服务安全。',
    '拒绝连接：本次连接被拒绝；设备、服务或防火墙设置变化后，结果可能不同。',
    '未响应：在等待时间内没有明确回应，无法判断端口是否开放。',
    '不可用：本次连接未能进行，不能据此判断服务状态。',
    '未检查：本次任务没有获得该端口的观察结果。',
    '端口旁的名称仅是常见用途，不代表已经识别设备实际运行的服务。',
    '本报告是当前内存中观察结果的副本；生成报告不会发起新的检查。',
    '程序未记录检查的准确时间；发现时间与报告生成时间不能替代检查时间。',
    '',
    '接下来可以做什么',
    '先确认这台设备属于自己，或自己已获准管理。',
    '如果不需要远程管理或文件共享，可在设备设置中关闭相关功能。',
    '为设备安装官方更新，并为管理账号设置独立、足够长的密码。',
    '遇到不认识的设备，先在路由器列表中核对，再联系网络管理员。',
    '分享前注意隐私：报告包含设备名称和 IP 地址，请按需遮盖。',
    '',
  ];
  return BOM + lines.join(CRLF);
}
