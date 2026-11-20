import Fuse from '/vendor/fuse.min.js';

const text = value => typeof value === 'string' ? value.toLowerCase() : '';
const compactMac = value => value.replace(/[.:-]/g, '');

// Address-shaped input stays literal: decimal fragments, separated hex, full
// 12-character compact MACs, and shorter hex fragments containing a digit.
// Short alphabetic words such as "cafe" remain eligible for name/group typos.
function isAddressQuery(query) {
  return /^[0-9.]+$/.test(query)
    || (/^[0-9a-f.:-]+$/i.test(query) && /[.:-]/.test(query))
    || /^[0-9a-f]{12}$/i.test(query)
    || (/^[0-9a-f]+$/i.test(query) && /[0-9]/.test(query));
}

function matchesMode(device, mode) {
  if (mode === 'all') return true;
  if (mode === 'missing') return device.present === false;
  if (mode === 'review') return device.kind !== 'self' && device.profile?.known !== true && device.profile?.ignored !== true;
  return false;
}

// The index is a snapshot of searchable fields. Rebuild it when saved records
// change; search results preserve the original objects and their saved order.
export function createArchiveIndex(devices) {
  const entries = devices.map((device, index) => ({
    device, index,
    text: [device.name, device.displayName, device.profile?.alias, device.hostname, device.profile?.group].map(text).filter(Boolean),
    ip: text(device.ip),
    mac: text(device.mac),
    compactMac: compactMac(text(device.mac)),
  }));
  const fuse = new Fuse(entries, { keys: ['text'], threshold: 0.3, ignoreLocation: true });

  return {
    search(query = '', mode = 'all') {
      if (!['all', 'missing', 'review'].includes(mode)) return [];
      const normalized = text(query).trim();
      if (!normalized) return entries.filter(entry => matchesMode(entry.device, mode)).map(entry => entry.device);
      // Keep dotted IP input intact instead of turning its octets into a MAC.
      const compactQuery = /^[0-9a-f:-]+$/i.test(normalized) ? compactMac(normalized) : '';
      const fuzzyMatches = new Set(isAddressQuery(normalized) ? [] : fuse.search(normalized).map(result => result.item.index));
      return entries.filter(entry => matchesMode(entry.device, mode) && (
        entry.text.some(value => value.includes(normalized))
        || entry.ip.includes(normalized)
        || entry.mac.includes(normalized)
        || (compactQuery && entry.compactMac.includes(compactQuery))
        || fuzzyMatches.has(entry.index)
      )).map(entry => entry.device);
    },
  };
}
