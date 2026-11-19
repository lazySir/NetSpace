"""Transactional local discovery history and user-owned device profiles.

An observation is evidence of discovery, not proof of online/offline state.
Network and device IDs are opaque and scoped; IP addresses are never global
device identities. Historical snapshots retain the profiles visible at scan time.
"""

import copy
import datetime
import hashlib
import ipaddress
import json
import re
import sqlite3
import threading
import uuid
from collections import Counter
from contextlib import contextmanager


DEFAULT_PROFILE = {'alias': '', 'notes': '', 'group': '',
                   'known': False, 'ignored': False}
PROFILE_TEXT_LIMITS = {'alias': 80, 'notes': 1000, 'group': 40}
SNAPSHOT_RETENTION = 500
EVENT_RETENTION = 2000


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def _mac(value):
    if not isinstance(value, str):
        return None
    compact = value.strip().replace(':', '').replace('-', '')
    if re.fullmatch(r'[0-9A-Fa-f]{12}', compact) is None:
        return None
    octets = bytes.fromhex(compact)
    if octets == b'\x00' * 6 or octets[0] & 1:
        return None
    return ':'.join('{:02X}'.format(octet) for octet in octets)


def _device_ip(device):
    value = device.get('ip') or device.get('id')
    if not isinstance(value, str) or not value:
        raise ValueError('设备缺少有效的 IP 地址。')
    return value


def _network_identity(result):
    interface = result['interface']
    scope = result.get('scope') or {}
    cidr = interface.get('cidr') or scope.get('cidr')
    if not cidr and interface.get('ip') and interface.get('prefixLength') is not None:
        cidr = str(ipaddress.ip_network(
            '{}/{}'.format(interface['ip'], interface['prefixLength']), strict=False))
    if cidr:
        try:
            cidr = str(ipaddress.ip_network(cidr, strict=False))
        except (ValueError, TypeError) as error:
            raise ValueError('扫描结果包含无效的网络范围。') from error
    else:
        # A few injected scanners only identify their interface. Keep their
        # fallback scoped rather than assigning a global IP-based identity.
        cidr = ''
    gateway = interface.get('gateway') or None
    if gateway is not None and not isinstance(gateway, str):
        raise ValueError('扫描结果包含无效的网关。')
    gateway_macs = {_mac(device.get('mac')) for device in result['devices']
                    if (device.get('ip') or device.get('id')) == gateway}
    gateway_macs.discard(None)
    gateway_mac = next(iter(gateway_macs)) if len(gateway_macs) == 1 else None
    adapter_mac = _mac(interface.get('mac'))
    if adapter_mac:
        adapter_key = 'mac:' + adapter_mac
    else:
        fallback = [interface.get('id'), interface.get('alias'), interface.get('ip')]
        adapter_key = 'interface:' + hashlib.sha256(_json(fallback).encode('utf-8')).hexdigest()
    return cidr, gateway, gateway_mac, adapter_key


def _validate_profile(changes):
    if not isinstance(changes, dict) or set(changes) - set(DEFAULT_PROFILE):
        raise ValueError('设备资料包含无效字段。')
    for field, value in changes.items():
        if field in PROFILE_TEXT_LIMITS:
            if not isinstance(value, str) or len(value) > PROFILE_TEXT_LIMITS[field]:
                raise ValueError('设备资料的文字类型或长度不正确。')
        elif type(value) is not bool:
            raise ValueError('设备资料的开关必须为布尔值。')


def _validate_limit(limit):
    if type(limit) is not int or limit <= 0:
        raise ValueError('记录数量必须为正整数。')


class NetworkStore:
    """A locked SQLite repository usable from HTTP and scan worker threads."""

    def __init__(self, path=':memory:'):
        self._lock = threading.RLock()
        self._connection = sqlite3.connect(path, timeout=15, check_same_thread=False,
                                           isolation_level=None)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute('PRAGMA foreign_keys = ON')
        self._closed = False
        try:
            self._initialize()
        except BaseException:
            self.close()
            raise

    @contextmanager
    def _transaction(self):
        with self._lock:
            # Acquire SQLite's write reservation before comparing the previous
            # scan, also preventing duplicate events across separate handles.
            self._connection.execute('BEGIN IMMEDIATE')
            try:
                yield self._connection
                self._connection.execute('COMMIT')
            except BaseException:
                if self._connection.in_transaction:
                    self._connection.execute('ROLLBACK')
                raise

    def _initialize(self):
        statements = [
            "CREATE TABLE IF NOT EXISTS networks ("
            "id TEXT PRIMARY KEY, cidr TEXT NOT NULL, gateway TEXT, gateway_mac TEXT, "
            "adapter_key TEXT NOT NULL, label TEXT NOT NULL, last_seen TEXT NOT NULL, "
            "device_count INTEGER NOT NULL DEFAULT 0, last_scan_id INTEGER)",
            "CREATE INDEX IF NOT EXISTS networks_identity ON networks(cidr, gateway, gateway_mac)",
            "CREATE TABLE IF NOT EXISTS devices ("
            "network_id TEXT NOT NULL REFERENCES networks(id), device_key TEXT NOT NULL, "
            "mac TEXT, ip TEXT NOT NULL, data TEXT NOT NULL, profile TEXT NOT NULL, "
            "first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, present INTEGER NOT NULL, "
            "PRIMARY KEY(network_id, device_key))",
            # A MAC can legitimately appear at several IPs (multi-address
            # hosts or proxy ARP). Upgrade the original uniqueness constraint
            # so ambiguous associations can retain separate stable profiles.
            "DROP INDEX IF EXISTS devices_mac",
            "CREATE INDEX IF NOT EXISTS devices_mac_lookup ON devices(network_id, mac, ip) "
            "WHERE mac IS NOT NULL",
            "CREATE TABLE IF NOT EXISTS scans ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, network_id TEXT NOT NULL REFERENCES networks(id), "
            "scanned_at TEXT NOT NULL, device_count INTEGER NOT NULL, change_count INTEGER NOT NULL, "
            "duration_ms REAL NOT NULL, snapshot TEXT NOT NULL)",
            "CREATE INDEX IF NOT EXISTS scans_network ON scans(network_id, id DESC)",
            "CREATE TABLE IF NOT EXISTS events ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, network_id TEXT NOT NULL REFERENCES networks(id), "
            "scan_id INTEGER NOT NULL, device_key TEXT NOT NULL, kind TEXT NOT NULL, "
            "ip TEXT NOT NULL, previous_ip TEXT, name TEXT NOT NULL, occurred_at TEXT NOT NULL, "
            "read INTEGER NOT NULL, notify INTEGER NOT NULL)",
            "CREATE INDEX IF NOT EXISTS events_network ON events(network_id, id DESC)",
            "CREATE INDEX IF NOT EXISTS events_unread ON events(network_id, device_key) "
            "WHERE notify = 1 AND read = 0",
            "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        ]
        with self._transaction() as connection:
            for statement in statements:
                connection.execute(statement)
            connection.execute('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)',
                               ('notificationsEnabled', 'true'))

    def _find_network(self, connection, identity, label, scanned_at):
        cidr, gateway, gateway_mac, adapter_key = identity
        candidates = connection.execute(
            'SELECT * FROM networks WHERE cidr = ? AND gateway IS ?',
            (cidr, gateway)).fetchall()
        selected = None
        if gateway_mac:
            selected = next((row for row in candidates if row['gateway_mac'] == gateway_mac), None)
            if selected is None:
                provisional = [row for row in candidates
                               if row['gateway_mac'] is None and row['adapter_key'] == adapter_key]
                if len(provisional) == 1:
                    selected = provisional[0]
                    connection.execute('UPDATE networks SET gateway_mac = ? WHERE id = ?',
                                       (gateway_mac, selected['id']))
        else:
            matching = [row for row in candidates if row['adapter_key'] == adapter_key]
            provisional = [row for row in matching if row['gateway_mac'] is None]
            if len(provisional) == 1:
                selected = provisional[0]
            elif len(matching) == 1:
                selected = matching[0]
        if selected is not None:
            # The last adapter is the only conservative fallback when gateway
            # evidence is temporarily unavailable on a subsequent scan.
            connection.execute('UPDATE networks SET adapter_key = ? WHERE id = ?',
                               (adapter_key, selected['id']))
            return selected['id'], selected['last_scan_id'] is None
        network_id = uuid.uuid4().hex
        connection.execute(
            'INSERT INTO networks(id, cidr, gateway, gateway_mac, adapter_key, label, last_seen) '
            'VALUES (?, ?, ?, ?, ?, ?, ?)',
            (network_id, cidr, gateway, gateway_mac, adapter_key, label, scanned_at))
        return network_id, True

    @staticmethod
    def _enriched_device(facts, device_key, profile, first_seen, last_seen):
        enriched = copy.deepcopy(facts)
        enriched.update(deviceKey=device_key, profile=copy.deepcopy(profile),
                        firstSeen=first_seen, lastSeen=last_seen)
        return enriched

    @staticmethod
    def _event_name(facts, profile, ip):
        return str(profile.get('alias') or facts.get('hostname') or ip)

    def record_scan(self, result):
        """Persist a quiet baseline or one atomic scan/profile/change transaction."""
        if not isinstance(result, dict):
            raise ValueError('扫描结果格式不正确。')
        enriched = copy.deepcopy(result)
        if (not isinstance(enriched.get('interface'), dict) or
                not isinstance(enriched.get('devices'), list) or
                not all(isinstance(device, dict) for device in enriched['devices'])):
            raise ValueError('扫描结果缺少接口或设备列表。')
        scanned_at = enriched.get('scannedAt')
        if not isinstance(scanned_at, str) or not scanned_at:
            scanned_at = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')
            enriched['scannedAt'] = scanned_at
        duration = enriched.get('durationMs', 0)
        if type(duration) not in (int, float) or duration < 0:
            raise ValueError('扫描耗时格式不正确。')
        identity = _network_identity(enriched)
        label = str(enriched['interface'].get('alias') or identity[0] or '本地网络')
        observations = enriched['devices']
        ip_counts = Counter(_device_ip(device) for device in observations)
        mac_ips = {}
        for device in observations:
            mac = _mac(device.get('mac'))
            if mac:
                mac_ips.setdefault(mac, set()).add(_device_ip(device))
        with self._transaction() as connection:
            network_id, baseline = self._find_network(connection, identity, label, scanned_at)
            prior = [dict(row) for row in connection.execute(
                'SELECT * FROM devices WHERE network_id = ? ORDER BY rowid', (network_id,)).fetchall()]
            by_mac = {}
            by_ip = {}
            for row in prior:
                if row['mac']:
                    by_mac.setdefault(row['mac'], []).append(row)
                by_ip.setdefault(row['ip'], []).append(row)
            current_keys = set()
            pending_events = []
            output = []
            for facts in observations:
                ip = _device_ip(facts)
                mac = _mac(facts.get('mac'))
                existing = None
                if mac:
                    matches = by_mac.get(mac, [])
                    exact = [row for row in matches if row['ip'] == ip
                             and row['device_key'] not in current_keys]
                    if len(exact) == 1:
                        existing = exact[0]
                    elif (len(matches) == 1 and len(mac_ips[mac]) == 1
                          and matches[0]['device_key'] not in current_keys):
                        # Only an unambiguous MAC supports an IP move. Once
                        # several records share it, never steal another IP's
                        # profile merely because this scan sees one address.
                        existing = matches[0]
                if existing is None and ip_counts[ip] == 1:
                    candidates = by_ip.get(ip, [])
                    if len(candidates) == 1:
                        candidate = candidates[0]
                        mac_seen_elsewhere = (candidate['mac'] in mac_ips and
                                              mac_ips[candidate['mac']] != {ip})
                        if (candidate['device_key'] not in current_keys and
                                (not mac or not candidate['mac']) and not mac_seen_elsewhere):
                            existing = candidate
                is_new = existing is None
                if is_new:
                    device_key = uuid.uuid4().hex
                    profile = DEFAULT_PROFILE.copy()
                    first_seen = scanned_at
                    connection.execute(
                        'INSERT INTO devices(network_id, device_key, mac, ip, data, profile, '
                        'first_seen, last_seen, present) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)',
                        (network_id, device_key, mac, ip, _json(facts), _json(profile),
                         first_seen, scanned_at))
                else:
                    device_key = existing['device_key']
                    profile = json.loads(existing['profile'])
                    first_seen = existing['first_seen']
                    connection.execute(
                        'UPDATE devices SET mac = ?, ip = ?, data = ?, last_seen = ?, present = 1 '
                        'WHERE network_id = ? AND device_key = ?',
                        (mac or existing['mac'], ip, _json(facts), scanned_at, network_id, device_key))
                if device_key not in current_keys and not baseline:
                    if is_new:
                        pending_events.append((device_key, 'new', ip, None,
                                               self._event_name(facts, profile, ip), not profile['ignored']))
                    else:
                        if not existing['present']:
                            pending_events.append((device_key, 'returned', ip, None,
                                                   self._event_name(facts, profile, ip), False))
                        if ip != existing['ip']:
                            pending_events.append((device_key, 'ip_changed', ip, existing['ip'],
                                                   self._event_name(facts, profile, ip), False))
                current_keys.add(device_key)
                output.append(self._enriched_device(facts, device_key, profile, first_seen, scanned_at))
            for missing in prior:
                if missing['device_key'] in current_keys or not missing['present']:
                    continue
                connection.execute(
                    'UPDATE devices SET present = 0 WHERE network_id = ? AND device_key = ?',
                    (network_id, missing['device_key']))
                if not baseline:
                    pending_events.append((missing['device_key'], 'not_seen', missing['ip'], None,
                                           self._event_name(json.loads(missing['data']),
                                                            json.loads(missing['profile']), missing['ip']), False))
            cursor = connection.execute(
                'INSERT INTO scans(network_id, scanned_at, device_count, change_count, duration_ms, snapshot) '
                'VALUES (?, ?, ?, ?, ?, ?)',
                (network_id, scanned_at, len(output), len(pending_events), duration, '{}'))
            scan_id = cursor.lastrowid
            enriched.update(networkId=network_id, scanId=scan_id, devices=output)
            connection.execute('UPDATE scans SET snapshot = ? WHERE id = ?', (_json(enriched), scan_id))
            for device_key, kind, ip, previous_ip, name, notify in pending_events:
                connection.execute(
                    'INSERT INTO events(network_id, scan_id, device_key, kind, ip, previous_ip, name, '
                    'occurred_at, read, notify) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    (network_id, scan_id, device_key, kind, ip, previous_ip, name, scanned_at,
                     int(not notify), int(notify)))
            connection.execute(
                'UPDATE networks SET label = ?, last_seen = ?, device_count = ?, last_scan_id = ? WHERE id = ?',
                (label, scanned_at, len(output), scan_id, network_id))
            connection.execute(
                'DELETE FROM scans WHERE network_id = ? AND id NOT IN '
                '(SELECT id FROM scans WHERE network_id = ? ORDER BY id DESC LIMIT ?)',
                (network_id, network_id, SNAPSHOT_RETENTION))
            connection.execute(
                'DELETE FROM events WHERE network_id = ? AND id NOT IN '
                '(SELECT id FROM events WHERE network_id = ? ORDER BY id DESC LIMIT ?)',
                (network_id, network_id, EVENT_RETENTION))
        return enriched

    def list_networks(self):
        with self._lock:
            rows = self._connection.execute(
                'SELECT id, label, cidr, gateway, last_seen, device_count FROM networks '
                'ORDER BY last_scan_id DESC').fetchall()
            return [{'id': row['id'], 'label': row['label'], 'cidr': row['cidr'],
                     'gateway': row['gateway'], 'lastSeen': row['last_seen'],
                     'deviceCount': row['device_count']} for row in rows]

    def list_scans(self, network_id=None, limit=50):
        _validate_limit(limit)
        with self._lock:
            rows = self._connection.execute(
                'SELECT id, network_id, scanned_at, device_count, change_count, duration_ms FROM scans '
                'WHERE (? IS NULL OR network_id = ?) ORDER BY id DESC LIMIT ?',
                (network_id, network_id, limit)).fetchall()
            return [{'id': row['id'], 'networkId': row['network_id'], 'scannedAt': row['scanned_at'],
                     'deviceCount': row['device_count'], 'changeCount': row['change_count'],
                     'durationMs': row['duration_ms']} for row in rows]

    def get_scan(self, scan_id):
        if isinstance(scan_id, int) and not 0 < scan_id < 2 ** 63:
            return None
        with self._lock:
            row = self._connection.execute('SELECT snapshot FROM scans WHERE id = ?', (scan_id,)).fetchone()
            return json.loads(row['snapshot']) if row is not None else None

    def get_devices(self, network_id):
        with self._lock:
            rows = self._connection.execute(
                'SELECT * FROM devices WHERE network_id = ? ORDER BY rowid', (network_id,)).fetchall()
            result = []
            for row in rows:
                device = self._enriched_device(json.loads(row['data']), row['device_key'],
                                               json.loads(row['profile']), row['first_seen'], row['last_seen'])
                device['present'] = bool(row['present'])
                result.append(device)
            return result

    def update_profile(self, network_id, device_key, changes):
        _validate_profile(changes)
        with self._transaction() as connection:
            row = connection.execute(
                'SELECT profile FROM devices WHERE network_id = ? AND device_key = ?',
                (network_id, device_key)).fetchone()
            if row is None:
                raise KeyError('设备不存在。')
            profile = json.loads(row['profile'])
            profile.update(changes)
            connection.execute('UPDATE devices SET profile = ? WHERE network_id = ? AND device_key = ?',
                               (_json(profile), network_id, device_key))
            if profile['ignored']:
                connection.execute(
                    'UPDATE events SET read = 1 WHERE network_id = ? AND device_key = ? AND read = 0 AND notify = 1',
                    (network_id, device_key))
            return profile

    def list_events(self, network_id=None, limit=50):
        _validate_limit(limit)
        with self._lock:
            rows = self._connection.execute(
                'SELECT * FROM events WHERE (? IS NULL OR network_id = ?) ORDER BY id DESC LIMIT ?',
                (network_id, network_id, limit)).fetchall()
            return [{'id': row['id'], 'networkId': row['network_id'], 'scanId': row['scan_id'],
                     'deviceKey': row['device_key'], 'kind': row['kind'], 'ip': row['ip'],
                     'previousIp': row['previous_ip'], 'name': row['name'], 'occurredAt': row['occurred_at'],
                     'read': bool(row['read']), 'notify': bool(row['notify'])} for row in rows]

    def unread_count(self, network_id=None):
        with self._lock:
            return self._connection.execute(
                'SELECT COUNT(*) FROM events WHERE notify = 1 AND read = 0 '
                'AND (? IS NULL OR network_id = ?)', (network_id, network_id)).fetchone()[0]

    def acknowledge_events(self, event_ids):
        if (not isinstance(event_ids, list) or
                any(type(event_id) is not int or event_id <= 0 for event_id in event_ids)):
            raise ValueError('事件编号必须是正整数列表。')
        updated = 0
        with self._transaction() as connection:
            for event_id in set(event_ids):
                if event_id >= 2 ** 63:
                    continue
                cursor = connection.execute('UPDATE events SET read = 1 WHERE id = ? AND read = 0', (event_id,))
                updated += cursor.rowcount
        return updated

    def acknowledge_network_events(self, network_id):
        if not isinstance(network_id, str) or not network_id.strip():
            raise ValueError('请选择有效的网络。')
        with self._transaction() as connection:
            cursor = connection.execute(
                'UPDATE events SET read = 1 WHERE network_id = ? AND notify = 1 AND read = 0',
                (network_id,))
            return cursor.rowcount

    def get_settings(self):
        with self._lock:
            row = self._connection.execute(
                'SELECT value FROM settings WHERE key = ?', ('notificationsEnabled',)).fetchone()
            return {'notificationsEnabled': json.loads(row['value'])}

    def set_settings(self, changes):
        if (not isinstance(changes, dict) or set(changes) - {'notificationsEnabled'} or
                any(type(value) is not bool for value in changes.values())):
            raise ValueError('通知设置必须是有效的布尔开关。')
        with self._transaction() as connection:
            if 'notificationsEnabled' in changes:
                connection.execute('UPDATE settings SET value = ? WHERE key = ?',
                                   (_json(changes['notificationsEnabled']), 'notificationsEnabled'))
            return self.get_settings()

    def close(self):
        with self._lock:
            if not self._closed:
                self._connection.close()
                self._closed = True
