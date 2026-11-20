import copy
import importlib
import math
import os
import sqlite3
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor


GATEWAY_MAC = '02:AA:00:00:00:01'
ADAPTER_MAC = '02:BB:00:00:00:01'


def peer(ip='192.168.50.30', mac='02:CC:00:00:00:01', **changes):
    result = {'id': ip, 'ip': ip, 'mac': mac, 'hostname': '工作电脑',
              'kind': 'device', 'status': 'resolved',
              'evidence': ['地址解析成功，不保证当前在线'], 'latencyMs': 1.2}
    result.update(changes)
    return result


def scan(*devices, **options):
    gateway_mac = options.get('gateway_mac', GATEWAY_MAC)
    gateway = peer('192.168.50.1', gateway_mac, kind='gateway', hostname=None,
                   status='resolved' if gateway_mac else 'unverified')
    return {
        'interface': {'id': '7', 'alias': '以太网', 'ip': '192.168.50.20',
                      'prefixLength': 24, 'cidr': '192.168.50.0/24',
                      'gateway': '192.168.50.1',
                      'mac': options.get('adapter_mac', ADAPTER_MAC)},
        'devices': [gateway] + list(devices),
        'links': [{'source': gateway['id'], 'target': d['id'],
                   'kind': 'same-subnet', 'inferred': True} for d in devices],
        'scannedAt': options.get('at', '2026-11-19T01:00:00+00:00'),
        'durationMs': 37, 'warnings': ['缓存不代表当前在线'],
        'scope': {'cidr': '192.168.50.0/24', 'targetCount': 253},
    }


class NetworkStoreTests(unittest.TestCase):
    def setUp(self):
        try:
            self.store_type = importlib.import_module('network_store').NetworkStore
        except ModuleNotFoundError:
            self.fail('NetworkStore persistent repository has not been implemented')
        self.store = self.store_type()

    def tearDown(self):
        if hasattr(self, 'store'):
            self.store.close()

    def test_first_scan_is_quiet_and_preserves_factual_input_without_mutation(self):
        original = scan(peer())
        before = copy.deepcopy(original)
        result = self.store.record_scan(original)
        self.assertEqual(original, before)
        self.assertIsInstance(result['networkId'], str)
        self.assertIsInstance(result['scanId'], int)
        device = result['devices'][1]
        for key, value in original['devices'][1].items():
            self.assertEqual(device[key], value)
        self.assertEqual(device['profile'], {'alias': '', 'notes': '', 'group': '',
                                             'known': False, 'ignored': False})
        self.assertEqual(device['firstSeen'], original['scannedAt'])
        self.assertEqual(device['lastSeen'], original['scannedAt'])
        self.assertEqual(self.store.list_events(), [])
        self.assertEqual(self.store.unread_count(), 0)
        result['devices'][1]['evidence'].append('changed by caller')
        saved = self.store.get_scan(result['scanId'])
        self.assertEqual(saved['devices'][1]['evidence'], before['devices'][1]['evidence'])
        self.assertIsNone(self.store.get_scan(999999))

    def test_online_backup_reopens_with_profiles_history_events_and_settings(self):
        first = self.store.record_scan(scan(peer()))
        network_id = first['networkId']
        device_key = first['devices'][1]['deviceKey']
        profile = {'alias': '备份设备', 'notes': '仅保存在本机', 'group': '办公',
                   'known': True, 'ignored': False}
        self.store.update_profile(network_id, device_key, profile)
        second = self.store.record_scan(scan(peer(), peer('192.168.50.41', '02:DD:00:00:00:01')))
        self.store.set_settings({'notificationsEnabled': False})

        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, 'backup.sqlite3')
            destination = sqlite3.connect(path)
            try:
                self.store.backup_to(destination)
            finally:
                destination.close()

            copied_db = sqlite3.connect(path)
            try:
                self.assertEqual(copied_db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            finally:
                copied_db.close()
            copied = self.store_type(path)
            try:
                self.assertEqual(copied.get_settings(), {'notificationsEnabled': False})
                self.assertEqual(len(copied.list_scans(network_id)), 2)
                self.assertEqual(copied.get_scan(second['scanId'])['devices'][1]['profile'], profile)
                self.assertEqual(copied.get_devices(network_id)[1]['profile'], profile)
                self.assertEqual(copied.list_events()[0]['kind'], 'new')
            finally:
                copied.close()

    def test_online_backup_remains_integral_during_concurrent_scan_writes(self):
        self.store.record_scan(scan(peer()))
        rendezvous = threading.Barrier(2)

        def write_scans():
            rendezvous.wait()
            for index in range(10):
                address = '192.168.50.{}'.format(40 + index)
                self.store.record_scan(scan(peer(address, '02:DD:00:00:{:02X}:01'.format(index)),
                                            at='2026-11-20T00:{:02d}:00+00:00'.format(index)))

        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, 'concurrent-backup.sqlite3')

            def create_backup():
                rendezvous.wait()
                destination = sqlite3.connect(path)
                try:
                    self.store.backup_to(destination)
                finally:
                    destination.close()

            with ThreadPoolExecutor(max_workers=2) as executor:
                writer = executor.submit(write_scans)
                backup = executor.submit(create_backup)
                writer.result(timeout=5)
                backup.result(timeout=5)

            copied = sqlite3.connect(path)
            try:
                self.assertEqual(copied.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
                count = copied.execute('SELECT COUNT(*) FROM scans').fetchone()[0]
                self.assertGreaterEqual(count, 1)
                self.assertLessEqual(count, 11)
            finally:
                copied.close()

    def test_restart_preserves_profiles_settings_history_and_alert_read_state(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, 'history.sqlite3')
            store = self.store_type(path)
            first = store.record_scan(scan(peer()))
            network_id = first['networkId']
            key = first['devices'][1]['deviceKey']
            profile = {'alias': '我的电脑', 'notes': '<script>原样保留</script>',
                       'group': '办公', 'known': True, 'ignored': False}
            store.update_profile(network_id, key, profile)
            second = store.record_scan(scan(peer(), peer('192.168.50.40', '02:DD:00:00:00:01')))
            alert = store.list_events()[0]
            store.acknowledge_events([alert['id']])
            store.set_settings({'notificationsEnabled': False})
            store.close()
            reopened = self.store_type(path)
            try:
                self.assertEqual(reopened.get_settings(), {'notificationsEnabled': False})
                self.assertEqual(len(reopened.list_scans(network_id)), 2)
                self.assertEqual(reopened.get_scan(second['scanId'])['devices'][1]['profile'], profile)
                self.assertEqual(reopened.get_devices(network_id)[1]['profile'], profile)
                self.assertTrue(reopened.list_events()[0]['read'])
                self.assertEqual(reopened.unread_count(), 0)
            finally:
                reopened.close()

    def test_networks_sharing_cidr_and_gateway_but_different_gateway_macs_are_isolated(self):
        first = self.store.record_scan(scan(peer()))
        self.store.update_profile(first['networkId'], first['devices'][1]['deviceKey'], {'alias': '家庭电脑'})
        second = self.store.record_scan(scan(peer(), gateway_mac='02:AA:00:00:00:02'))
        self.assertNotEqual(first['networkId'], second['networkId'])
        self.assertEqual(second['devices'][1]['profile']['alias'], '')
        self.assertEqual(len(self.store.list_networks()), 2)
        self.assertEqual(len(self.store.list_scans(first['networkId'])), 1)
        self.assertEqual(self.store.list_events(second['networkId']), [])

    def test_resolved_gateway_identity_survives_adapter_change_and_mac_format(self):
        first = self.store.record_scan(scan(peer()))
        second = self.store.record_scan(scan(peer(), adapter_mac='02:BB:00:00:00:02',
                                             gateway_mac=GATEWAY_MAC.lower().replace(':', '-')))
        self.assertEqual(first['networkId'], second['networkId'])
        self.assertEqual(first['devices'][0]['deviceKey'], second['devices'][0]['deviceKey'])

    def test_missing_gateway_mac_uses_adapter_fallback_and_can_be_promoted(self):
        first = self.store.record_scan(scan(peer(), gateway_mac=None))
        self.store.update_profile(first['networkId'], first['devices'][1]['deviceKey'], {'notes': '保留'})
        other = self.store.record_scan(scan(peer(), gateway_mac=None, adapter_mac='02:BB:00:00:00:02'))
        promoted = self.store.record_scan(scan(peer()))
        self.assertNotEqual(first['networkId'], other['networkId'])
        self.assertEqual(first['networkId'], promoted['networkId'])
        self.assertEqual(promoted['devices'][1]['profile']['notes'], '保留')
        unresolved = self.store.record_scan(scan(peer(), gateway_mac=None))
        self.assertEqual(unresolved['networkId'], first['networkId'])

    def test_mac_identity_survives_ip_change_and_preserves_profile_and_first_seen(self):
        first = self.store.record_scan(scan(peer()))
        self.store.update_profile(first['networkId'], first['devices'][1]['deviceKey'], {'alias': '开发机'})
        second = self.store.record_scan(scan(peer('192.168.50.80'), at='2026-11-19T01:05:00+00:00'))
        device = second['devices'][1]
        self.assertEqual(device['deviceKey'], first['devices'][1]['deviceKey'])
        self.assertEqual(device['profile']['alias'], '开发机')
        self.assertEqual(device['firstSeen'], first['scannedAt'])
        self.assertEqual(device['lastSeen'], second['scannedAt'])
        events = self.store.list_events()
        self.assertEqual([event['kind'] for event in events], ['ip_changed'])
        self.assertEqual(events[0]['previousIp'], '192.168.50.30')
        self.assertEqual(events[0]['ip'], '192.168.50.80')
        self.assertFalse(events[0]['notify'])

    def test_unambiguous_provisional_device_gains_mac_without_becoming_new(self):
        first = self.store.record_scan(scan(peer(mac=None)))
        key = first['devices'][1]['deviceKey']
        self.store.update_profile(first['networkId'], key, {'alias': '暂时无 MAC'})
        promoted = self.store.record_scan(scan(peer()))
        self.assertEqual(promoted['devices'][1]['deviceKey'], key)
        self.assertEqual(promoted['devices'][1]['profile']['alias'], '暂时无 MAC')
        self.assertEqual(len(self.store.get_devices(first['networkId'])), 2)
        self.assertEqual(self.store.list_events(), [])
        moved = self.store.record_scan(scan(peer('192.168.50.90')))
        self.assertEqual(moved['devices'][1]['deviceKey'], key)

    def test_shared_mac_addresses_have_distinct_profiles_and_repeated_scans_are_quiet(self):
        left = peer('192.168.50.30')
        right = peer('192.168.50.31', mac=left['mac'].lower().replace(':', '-'))
        first = self.store.record_scan(scan(left, right))
        first_keys = {device['ip']: device['deviceKey'] for device in first['devices']}
        self.assertNotEqual(first_keys[left['ip']], first_keys[right['ip']])
        self.store.update_profile(first['networkId'], first_keys[left['ip']], {'alias': '地址甲'})
        self.store.update_profile(first['networkId'], first_keys[right['ip']], {'alias': '地址乙'})
        for devices in ((left, right), (right, left), (left, right)):
            result = self.store.record_scan(scan(*devices))
            current = {device['ip']: device for device in result['devices']}
            self.assertEqual({ip: device['deviceKey'] for ip, device in current.items()}, first_keys)
            self.assertEqual(current[left['ip']]['profile']['alias'], '地址甲')
            self.assertEqual(current[right['ip']]['profile']['alias'], '地址乙')
            self.assertEqual(self.store.list_events(), [])
            self.assertEqual(self.store.list_scans(limit=1)[0]['changeCount'], 0)
        self.assertEqual(len(self.store.get_devices(first['networkId'])), 3)

    def test_identical_shared_mac_scan_never_manufactures_repeated_ip_changes(self):
        observations = scan(peer('192.168.50.30'), peer('192.168.50.31'))
        self.store.record_scan(observations)
        for _ in range(3):
            self.store.record_scan(observations)
            self.assertEqual(self.store.list_events(), [])

    def test_unique_mac_expansion_retains_existing_address_and_collapse_does_not_move_profiles(self):
        left = peer('192.168.50.30')
        right = peer('192.168.50.31')
        first = self.store.record_scan(scan(left))
        key = first['devices'][1]['deviceKey']
        self.store.update_profile(first['networkId'], key, {'alias': '原地址'})
        expanded = self.store.record_scan(scan(right, left))
        expanded_devices = {device['ip']: device for device in expanded['devices']}
        self.assertEqual(expanded_devices[left['ip']]['deviceKey'], key)
        self.assertNotEqual(expanded_devices[right['ip']]['deviceKey'], key)
        self.assertEqual(expanded_devices[right['ip']]['profile']['alias'], '')
        self.assertNotIn('ip_changed', [event['kind'] for event in self.store.list_events()])
        collapsed = self.store.record_scan(scan(right))
        self.assertEqual(collapsed['devices'][1]['deviceKey'], expanded_devices[right['ip']]['deviceKey'])
        self.assertEqual(collapsed['devices'][1]['profile']['alias'], '')
        event_count = len(self.store.list_events())
        self.store.record_scan(scan(right))
        self.assertEqual(len(self.store.list_events()), event_count)
        self.assertNotIn('ip_changed', [event['kind'] for event in self.store.list_events()])
        moved = self.store.record_scan(scan(peer('192.168.50.90')))
        self.assertNotIn(moved['devices'][1]['deviceKey'],
                         [device['deviceKey'] for device in expanded['devices'][1:]])
        self.assertEqual(moved['devices'][1]['profile']['alias'], '')
        self.assertNotIn('ip_changed', [event['kind'] for event in self.store.list_events()])

    def test_shared_mac_identity_is_stable_after_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, 'history.sqlite3')
            store = self.store_type(path)
            first = store.record_scan(scan(peer('192.168.50.30'), peer('192.168.50.31')))
            first_keys = {device['ip']: device['deviceKey'] for device in first['devices']}
            store.close()
            reopened = self.store_type(path)
            try:
                repeated = reopened.record_scan(scan(peer('192.168.50.31'), peer('192.168.50.30')))
                self.assertEqual({device['ip']: device['deviceKey'] for device in repeated['devices']}, first_keys)
                self.assertEqual(reopened.list_events(), [])
            finally:
                reopened.close()

    def test_legacy_unique_mac_index_is_migrated_before_shared_mac_records_are_written(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, 'history.sqlite3')
            store = self.store_type(path)
            first = store.record_scan(scan(peer('192.168.50.30')))
            store.close()
            connection = sqlite3.connect(path)
            connection.execute('DROP INDEX IF EXISTS devices_mac_lookup')
            connection.execute('CREATE UNIQUE INDEX IF NOT EXISTS devices_mac ON devices(network_id, mac) '
                               'WHERE mac IS NOT NULL')
            connection.commit()
            connection.close()
            reopened = self.store_type(path)
            try:
                shared = reopened.record_scan(scan(peer('192.168.50.30'), peer('192.168.50.31')))
                self.assertEqual(shared['networkId'], first['networkId'])
                self.assertEqual(len({device['deviceKey'] for device in shared['devices']}), 3)
                self.assertEqual(len(reopened.get_devices(first['networkId'])), 3)
            finally:
                reopened.close()

    def test_different_mac_at_reused_ip_is_a_new_device_and_keeps_old_profile(self):
        first = self.store.record_scan(scan(peer()))
        key = first['devices'][1]['deviceKey']
        self.store.update_profile(first['networkId'], key, {'alias': '原设备'})
        second = self.store.record_scan(scan(peer(mac='02:CC:00:00:00:02')))
        self.assertNotEqual(second['devices'][1]['deviceKey'], key)
        self.assertEqual(second['devices'][1]['profile']['alias'], '')
        stored = {item['deviceKey']: item for item in self.store.get_devices(first['networkId'])}
        self.assertFalse(stored[key]['present'])
        self.assertEqual(stored[key]['profile']['alias'], '原设备')
        self.assertEqual({item['kind'] for item in self.store.list_events()}, {'new', 'not_seen'})

    def test_ambiguous_same_ip_provisional_records_are_not_merged(self):
        provisional = peer(mac=None)
        known = peer(mac='02:CC:00:00:00:02')
        first = self.store.record_scan(scan(provisional, known))
        second = self.store.record_scan(scan(peer()))
        self.assertNotIn(second['devices'][1]['deviceKey'],
                         [item['deviceKey'] for item in first['devices'][1:]])
        self.assertEqual(len(self.store.get_devices(first['networkId'])), 4)

    def test_events_compare_previous_snapshot_and_never_repeat_new_device_alert(self):
        first = self.store.record_scan(scan())
        second = self.store.record_scan(scan(peer()))
        event = self.store.list_events()[0]
        self.assertEqual(event['kind'], 'new')
        self.assertEqual(event['networkId'], first['networkId'])
        self.assertEqual(event['scanId'], second['scanId'])
        self.assertEqual(event['deviceKey'], second['devices'][1]['deviceKey'])
        self.assertEqual(event['name'], '工作电脑')
        self.assertTrue(event['notify'])
        self.assertFalse(event['read'])
        self.assertEqual(self.store.unread_count(first['networkId']), 1)
        self.store.record_scan(scan(peer()))
        self.assertEqual(len(self.store.list_events()), 1)
        self.store.record_scan(scan())
        self.store.record_scan(scan())
        self.assertEqual([e['kind'] for e in self.store.list_events()], ['not_seen', 'new'])
        returned = self.store.record_scan(scan(peer()))
        self.assertEqual(returned['devices'][1]['firstSeen'], second['scannedAt'])
        self.assertEqual([e['kind'] for e in self.store.list_events()], ['returned', 'not_seen', 'new'])
        self.assertFalse(self.store.list_events()[0]['notify'])
        self.assertEqual(self.store.unread_count(), 1)

    def test_ignored_device_marks_pending_notifications_read_and_mute_only_gates_ui(self):
        baseline = self.store.record_scan(scan())
        added = self.store.record_scan(scan(peer()))
        key = added['devices'][1]['deviceKey']
        self.store.update_profile(baseline['networkId'], key, {'ignored': True})
        self.assertEqual(self.store.unread_count(), 0)
        self.assertTrue(self.store.list_events()[0]['read'])
        self.store.record_scan(scan())
        self.store.record_scan(scan(peer()))
        self.assertEqual(self.store.unread_count(), 0)
        self.store.set_settings({'notificationsEnabled': False})
        self.store.record_scan(scan(peer(), peer('192.168.50.40', '02:DD:00:00:00:01')))
        self.assertEqual(self.store.unread_count(), 1)
        self.assertTrue(self.store.list_events()[0]['notify'])

    def test_acknowledgement_is_idempotent_and_isolated_by_event_id(self):
        first = self.store.record_scan(scan())
        self.store.record_scan(scan(peer()))
        other = self.store.record_scan(scan(gateway_mac='02:AA:00:00:00:02'))
        self.store.record_scan(scan(peer(), gateway_mac='02:AA:00:00:00:02'))
        event = self.store.list_events(first['networkId'])[0]
        self.assertEqual(self.store.acknowledge_events([event['id'], event['id'], 999999]), 1)
        self.assertEqual(self.store.acknowledge_events([event['id']]), 0)
        self.assertEqual(self.store.acknowledge_events([]), 0)
        self.assertEqual(self.store.unread_count(first['networkId']), 0)
        self.assertEqual(self.store.unread_count(other['networkId']), 1)
        for invalid in (None, '1', [True], [0], [-1], ['1']):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.store.acknowledge_events(invalid)

    def test_network_acknowledgement_reads_all_notifications_beyond_latest_page(self):
        first = self.store.record_scan(scan())
        devices = [peer('192.168.50.{}'.format(index + 30),
                        '02:DD:00:00:00:{:02X}'.format(index + 1)) for index in range(60)]
        self.store.record_scan(scan(*devices))
        other = self.store.record_scan(scan(gateway_mac='02:AA:00:00:00:02'))
        self.store.record_scan(scan(peer(), gateway_mac='02:AA:00:00:00:02'))
        self.assertEqual(self.store.unread_count(first['networkId']), 60)
        self.assertEqual(len(self.store.list_events(first['networkId'])), 50)
        self.assertEqual(self.store.acknowledge_network_events(first['networkId']), 60)
        self.assertEqual(self.store.unread_count(first['networkId']), 0)
        self.assertTrue(all(event['read'] for event in
                            self.store.list_events(first['networkId'], limit=100)))
        self.assertEqual(self.store.unread_count(other['networkId']), 1)
        self.assertFalse(self.store.list_events(other['networkId'])[0]['read'])
        self.assertEqual(self.store.acknowledge_network_events(first['networkId']), 0)
        self.assertEqual(self.store.acknowledge_network_events('unknown-network'), 0)

    def test_network_acknowledgement_requires_a_nonempty_string_id(self):
        for invalid in (None, '', '   ', True, 0, [], {}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.store.acknowledge_network_events(invalid)

    def test_profile_fields_have_strict_validation_and_unknown_device_is_not_created(self):
        first = self.store.record_scan(scan(peer()))
        network_id = first['networkId']
        key = first['devices'][1]['deviceKey']
        for invalid in (None, [], {'alias': 'a' * 81}, {'notes': 'n' * 1001},
                        {'group': 'g' * 41}, {'alias': 7}, {'notes': None},
                        {'known': 1}, {'ignored': 'false'}, {'unexpected': ''}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.store.update_profile(network_id, key, invalid)
        valid = {'alias': 'a' * 80, 'notes': 'n' * 1000, 'group': 'g' * 40,
                 'known': True, 'ignored': True}
        self.assertEqual(self.store.update_profile(network_id, key, valid), valid)
        with self.assertRaises(KeyError):
            self.store.update_profile(network_id, 'missing', {'alias': '不会创建'})
        with self.assertRaises(KeyError):
            self.store.update_profile('missing', key, {'alias': '不会创建'})

    def test_settings_have_strict_boolean_validation(self):
        self.assertEqual(self.store.get_settings(), {'notificationsEnabled': True})
        for invalid in (None, [], {'notificationsEnabled': 1},
                        {'notificationsEnabled': 'true'}, {'unknown': True}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.store.set_settings(invalid)
        self.store.set_settings({'notificationsEnabled': False})
        self.assertEqual(self.store.get_settings(), {'notificationsEnabled': False})
        self.store.set_settings({})
        self.assertEqual(self.store.get_settings(), {'notificationsEnabled': False})

    def test_nonfinite_scan_duration_is_rejected_before_persistence(self):
        for duration in (math.nan, math.inf, -math.inf):
            with self.subTest(duration=duration):
                invalid = scan(peer())
                invalid['durationMs'] = duration
                with self.assertRaises(ValueError):
                    self.store.record_scan(invalid)
                self.assertEqual(self.store.list_scans(), [])
                self.assertEqual(self.store.list_networks(), [])
                self.assertEqual(self.store.list_events(), [])

    def test_profile_edits_do_not_rewrite_historical_snapshots(self):
        first = self.store.record_scan(scan(peer()))
        key = first['devices'][1]['deviceKey']
        self.store.update_profile(first['networkId'], key, {'alias': '现在的名称'})
        self.assertEqual(self.store.get_scan(first['scanId'])['devices'][1]['profile']['alias'], '')
        self.assertEqual(self.store.get_devices(first['networkId'])[1]['profile']['alias'], '现在的名称')
        next_scan = self.store.record_scan(scan(peer()))
        self.assertEqual(next_scan['devices'][1]['profile']['alias'], '现在的名称')

    def test_large_unknown_event_and_scan_ids_do_not_overflow_sqlite_parameters(self):
        first = self.store.record_scan(scan())
        self.store.record_scan(scan(peer()))
        huge_id = 10 ** 100
        self.assertIsNone(self.store.get_scan(huge_id))
        self.assertEqual(self.store.acknowledge_events([huge_id]), 0)
        self.assertEqual(self.store.unread_count(first['networkId']), 1)

    def test_network_and_scan_lists_are_current_and_ordered_newest_first(self):
        first = self.store.record_scan(scan(peer()))
        second = self.store.record_scan(scan(at='2026-11-19T01:05:00+00:00'))
        network = self.store.list_networks()[0]
        self.assertEqual(network, {'id': first['networkId'], 'label': '以太网',
                                   'cidr': '192.168.50.0/24', 'gateway': '192.168.50.1',
                                   'lastSeen': second['scannedAt'], 'deviceCount': 1})
        listed = self.store.list_scans(first['networkId'], limit=1)
        self.assertEqual(listed, [{'id': second['scanId'], 'networkId': first['networkId'],
                                   'scannedAt': second['scannedAt'], 'deviceCount': 1,
                                   'changeCount': 1, 'durationMs': 37}])
        self.assertEqual(self.store.get_devices('missing'), [])
        self.assertEqual(self.store.list_scans('missing'), [])
        self.assertEqual(self.store.list_events('missing'), [])
        for invalid in (0, -1, True, '5'):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.store.list_scans(limit=invalid)
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.store.list_events(limit=invalid)

    def test_sql_values_are_bound_and_profile_strings_round_trip(self):
        result = self.store.record_scan(scan(peer(hostname="'; DROP TABLE devices; --")))
        dangerous = "O'Reilly'); DROP TABLE scans; --"
        self.store.update_profile(result['networkId'], result['devices'][1]['deviceKey'], {'alias': dangerous})
        self.assertEqual(self.store.get_devices(result['networkId'])[1]['profile']['alias'], dangerous)
        self.assertEqual(len(self.store.list_scans()), 1)

    def test_same_store_is_safe_for_concurrent_scan_and_profile_access(self):
        first = self.store.record_scan(scan())
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: self.store.record_scan(scan(peer())), range(30)))
        self.assertTrue(all(item['networkId'] == first['networkId'] for item in results))
        self.assertEqual(len(self.store.list_scans()), 31)
        self.assertEqual([e['kind'] for e in self.store.list_events()], ['new'])
        self.assertEqual(self.store.unread_count(), 1)

    def test_two_connections_serialize_scan_comparison_atomically(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, 'history.sqlite3')
            left = self.store_type(path)
            right = self.store_type(path)
            try:
                first = left.record_scan(scan())
                with ThreadPoolExecutor(max_workers=2) as pool:
                    results = list(pool.map(lambda store: store.record_scan(scan(peer())), [left, right]))
                self.assertEqual({r['networkId'] for r in results}, {first['networkId']})
                self.assertEqual(len(left.list_scans()), 3)
                self.assertEqual([e['kind'] for e in right.list_events()], ['new'])
            finally:
                left.close()
                right.close()

    def test_failed_event_write_rolls_back_snapshot_devices_and_network_summary(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, 'history.sqlite3')
            store = self.store_type(path)
            try:
                first = store.record_scan(scan())
                before = store.list_networks()
                connection = sqlite3.connect(path)
                connection.execute("CREATE TRIGGER reject_event BEFORE INSERT ON events "
                                   "BEGIN SELECT RAISE(ABORT, 'forced write failure'); END")
                connection.commit()
                connection.close()
                with self.assertRaises(sqlite3.IntegrityError):
                    store.record_scan(scan(peer(), at='2026-11-19T01:05:00+00:00'))
                self.assertEqual(len(store.list_scans()), 1)
                self.assertEqual(len(store.get_devices(first['networkId'])), 1)
                self.assertEqual(store.list_networks(), before)
                self.assertEqual(store.list_events(), [])
            finally:
                store.close()

    def test_database_initiated_rollback_preserves_original_error_and_store_remains_usable(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, 'history.sqlite3')
            store = self.store_type(path)
            connection = None
            try:
                first = store.record_scan(scan())
                connection = sqlite3.connect(path)
                connection.execute("CREATE TRIGGER rollback_event BEFORE INSERT ON events "
                                   "BEGIN SELECT RAISE(ROLLBACK, 'forced rollback'); END")
                connection.commit()
                with self.assertRaisesRegex(sqlite3.IntegrityError, 'forced rollback'):
                    store.record_scan(scan(peer()))
                self.assertEqual(len(store.list_scans()), 1)
                self.assertEqual(len(store.get_devices(first['networkId'])), 1)
                connection.execute('DROP TRIGGER rollback_event')
                connection.commit()
                connection.close()
                connection = None
                store.record_scan(scan(peer()))
                self.assertEqual(store.unread_count(), 1)
            finally:
                if connection is not None:
                    connection.close()
                store.close()

    def test_snapshot_retention_is_per_network_and_retains_device_profiles(self):
        first = self.store.record_scan(scan(peer()))
        key = first['devices'][1]['deviceKey']
        self.store.update_profile(first['networkId'], key, {'alias': '长期保留'})
        other = self.store.record_scan(scan(gateway_mac='02:AA:00:00:00:02'))
        for _ in range(501):
            self.store.record_scan(scan())
        self.assertEqual(len(self.store.list_scans(first['networkId'], limit=1000)), 500)
        self.assertIsNone(self.store.get_scan(first['scanId']))
        self.assertIsNotNone(self.store.get_scan(other['scanId']))
        old = next(d for d in self.store.get_devices(first['networkId']) if d['deviceKey'] == key)
        self.assertEqual(old['profile']['alias'], '长期保留')
        self.assertFalse(old['present'])

    def test_event_retention_is_per_network_and_does_not_delete_profiles(self):
        first = self.store.record_scan(scan())
        other = self.store.record_scan(scan(gateway_mac='02:AA:00:00:00:02'))
        self.store.record_scan(scan(peer(), gateway_mac='02:AA:00:00:00:02'))
        devices = [peer('10.0.{}.{}'.format(index // 250, index % 250 + 1),
                        '02:EE:00:{:02X}:{:02X}:{:02X}'.format(index >> 16, (index >> 8) & 255, index & 255))
                   for index in range(2105)]
        self.store.record_scan(scan(*devices))
        self.assertEqual(len(self.store.list_events(first['networkId'], limit=3000)), 2000)
        self.assertEqual(len(self.store.list_events(other['networkId'], limit=3000)), 1)
        self.assertEqual(len(self.store.get_devices(first['networkId'])), 2106)

    def test_cleanup_catalogue_counts_and_delete_is_scoped_to_one_network(self):
        first = self.store.record_scan(scan(peer()))
        network_id = first['networkId']
        self.store.update_profile(network_id, first['devices'][1]['deviceKey'],
                                  {'alias': '只应随该网络删除'})
        self.store.record_scan(scan(peer(), peer('192.168.50.41', '02:DD:00:00:00:01'),
                                    at='2026-11-20T01:00:00+00:00'))
        other_network = scan(peer('192.168.60.30', '02:CC:00:00:60:01'))
        other_network['interface'].update(ip='192.168.60.20', cidr='192.168.60.0/24',
                                           gateway='192.168.60.1')
        other_network['devices'][0].update(id='192.168.60.1', ip='192.168.60.1',
                                            mac='02:AA:00:00:60:01')
        other_network['links'] = [{'source': '192.168.60.1', 'target': '192.168.60.30',
                                   'kind': 'same-subnet', 'inferred': True}]
        other = self.store.record_scan(other_network)
        self.store.set_settings({'notificationsEnabled': False})

        catalogue = {item['id']: item for item in self.store.list_network_cleanup_counts()}
        self.assertEqual(catalogue[network_id]['deviceCount'], 3)
        self.assertEqual(catalogue[network_id]['scanCount'], 2)
        self.assertEqual(catalogue[network_id]['eventCount'], 1)
        self.assertEqual(catalogue[other['networkId']]['deviceCount'], 2)
        self.assertEqual(catalogue[other['networkId']]['scanCount'], 1)
        self.assertEqual(catalogue[other['networkId']]['eventCount'], 0)

        deleted = self.store.delete_network(network_id)
        self.assertEqual(deleted, {'deviceCount': 3, 'scanCount': 2, 'eventCount': 1})
        self.assertEqual(self.store.list_network_cleanup_counts(), [catalogue[other['networkId']]])
        self.assertEqual(self.store.get_settings(), {'notificationsEnabled': False})
        self.assertEqual(len(self.store.get_devices(other['networkId'])), 2)
        self.assertEqual(len(self.store.list_scans(other['networkId'])), 1)
        self.assertEqual(self.store.list_events(other['networkId']), [])

    def test_cleanup_rejects_malformed_or_unknown_network_ids(self):
        for network_id in (None, True, '', 'A' * 32, '../' + 'a' * 30, 'a' * 31):
            with self.subTest(network_id=network_id):
                with self.assertRaises(ValueError):
                    self.store.delete_network(network_id)
        with self.assertRaises(KeyError):
            self.store.delete_network('f' * 32)

    def test_cleanup_rolls_back_all_rows_when_device_delete_fails(self):
        saved = self.store.record_scan(scan(peer()))
        network_id = saved['networkId']
        self.store.record_scan(scan(peer(), peer('192.168.50.41', '02:DD:00:00:00:01'),
                                    at='2026-11-20T01:00:00+00:00'))
        with self.store._lock:
            self.store._connection.execute(
                "CREATE TRIGGER block_cleanup_device_delete BEFORE DELETE ON devices "
                "BEGIN SELECT RAISE(ABORT, 'forced cleanup rollback'); END")
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'forced cleanup rollback'):
            self.store.delete_network(network_id)
        self.assertEqual(len(self.store.list_network_cleanup_counts()), 1)
        self.assertEqual(len(self.store.list_scans(network_id)), 2)
        self.assertEqual(len(self.store.get_devices(network_id)), 3)
        self.assertEqual(len(self.store.list_events(network_id)), 1)


if __name__ == '__main__':
    unittest.main()
