export function deviceIdentity(device) {
  if (typeof device.deviceKey === 'string' && device.deviceKey) return 'key:' + device.deviceKey;
  const mac = typeof device.mac === 'string' ? device.mac.replace(/[^a-f0-9]/gi, '').toLowerCase() : '';
  return mac ? 'mac:' + mac : 'ip:' + String(device.id || device.ip || '');
}
