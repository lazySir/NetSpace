import importlib
import base64
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from concurrent.futures import CancelledError
from unittest import mock


class LocalServerTests(unittest.TestCase):
    def setUp(self):
        try:
            self.app = importlib.import_module('app')
        except ModuleNotFoundError:
            self.fail('Local application server has not been implemented')
        self.calls = []
        self.gate = threading.Event()
        self.gate.set()
        self.check_calls = []
        self.check_gate = threading.Event()
        self.check_gate.set()
        self.interfaces = [{'id': '7', 'alias': 'Ethernet', 'ip': '192.168.50.20',
                            'prefixLength': 24, 'gateway': '192.168.50.1'}]

        def scanner(interface_id, progress):
            self.calls.append(interface_id)
            progress({'phase': 'probing', 'completed': 1, 'total': 2, 'message': 'Discovering'})
            self.gate.wait(3)
            return {'interface': self.interfaces[0], 'devices': [{'id': '192.168.50.20'}],
                    'links': [], 'warnings': [], 'scope': {'targetCount': 2}}

        def port_probe(ip, port):
            self.check_calls.append((ip, port))
            self.check_gate.wait(2)
            return {'port': port, 'service': '测试服务', 'status': 'closed'}

        self.port_probe = port_probe
        self.server = self.app.create_server(port=0, interfaces_provider=lambda: self.interfaces,
                                             scanner=scanner, port_probe=port_probe)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = 'http://127.0.0.1:{}'.format(self.server.server_port)

    def tearDown(self):
        if hasattr(self, 'server'):
            self.gate.set()
            self.check_gate.set()
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(2)

    def request(self, path, data=None, headers=None, method=None):
        payload = None if data is None else json.dumps(data).encode('utf-8')
        request_headers = {'Content-Type': 'application/json'}
        request_headers.update(headers or {})
        request = urllib.request.Request(self.base + path, data=payload, headers=request_headers, method=method)
        try:
            response = urllib.request.urlopen(request, timeout=3)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            body = response.read()
            content_type = response.headers.get('Content-Type', '')
            return response.status, json.loads(body.decode('utf-8')) if 'application/json' in content_type else body

    def save_check_snapshot(self, peer_ip='192.168.50.45', scanned_at=None, cidr='192.168.50.0/24',
                            peer_mac=None):
        import datetime
        if scanned_at is None:
            scanned_at = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')
        result = {'interface': {**self.interfaces[0], 'cidr': cidr},
                  'devices': [
                      {'id': self.interfaces[0]['ip'], 'ip': self.interfaces[0]['ip'], 'kind': 'self',
                       'hostname': 'TEST-WORKSTATION'},
                      {'id': peer_ip, 'ip': peer_ip, 'kind': 'device', 'hostname': 'TEST-PEER',
                       **({'mac': peer_mac} if peer_mac is not None else {})},
                  ],
                  'links': [], 'warnings': [], 'scope': {'cidr': cidr},
                  'scannedAt': scanned_at, 'durationMs': 1}
        saved = self.server.state.store.record_scan(result)
        with self.server.state.lock:
            self.server.state.result = saved
            self.server.state.status = 'complete'
        return saved

    def wait_for_check(self):
        for _ in range(100):
            check = self.request('/api/device-check')[1]
            if check['status'] != 'checking':
                return check
            time.sleep(.01)
        self.fail('device check did not complete')

    def wait_for_check_calls(self, count):
        for _ in range(100):
            if len(self.check_calls) >= count:
                return
            time.sleep(.01)
        self.fail('device check did not reach the expected fake probe')

    def test_device_check_requires_the_scan_id_seen_when_authorizing(self):
        saved = self.save_check_snapshot()
        peer = next(item for item in saved['devices'] if item['kind'] == 'device')
        body = {'networkId': saved['networkId'], 'deviceKey': peer['deviceKey'], 'authorized': True}
        origin = {'Origin': self.base}
        self.assertEqual(self.request('/api/device-check', body, origin, method='POST')[0], 400)
        for invalid in (None, True, False, 0, -1, 1.0, '1', [], {}):
            with self.subTest(scanId=invalid):
                self.assertEqual(self.request('/api/device-check', {**body, 'scanId': invalid},
                                              origin, method='POST')[0], 400)
        self.assertEqual(self.check_calls, [])
        status, check = self.request('/api/device-check', {**body, 'scanId': saved['scanId']},
                                     origin, method='POST')
        self.assertEqual(status, 202)
        self.assertEqual(check['scanId'], saved['scanId'])
        self.assertEqual(self.wait_for_check()['status'], 'complete')

    def test_old_scan_authorization_cannot_follow_a_mac_to_its_new_address(self):
        first = self.save_check_snapshot(peer_mac='02:00:00:00:00:45')
        peer = next(item for item in first['devices'] if item['kind'] == 'device')
        body = {'networkId': first['networkId'], 'deviceKey': peer['deviceKey'],
                'scanId': first['scanId'], 'authorized': True}
        latest = self.save_check_snapshot(peer_ip='192.168.50.46', peer_mac='02:00:00:00:00:45')
        current_peer = next(item for item in latest['devices'] if item['kind'] == 'device')
        self.assertEqual(latest['networkId'], first['networkId'])
        self.assertEqual(current_peer['deviceKey'], peer['deviceKey'])
        origin = {'Origin': self.base}
        self.assertEqual(self.request('/api/device-check', body, origin, method='POST')[0], 400)
        self.assertEqual(self.check_calls, [])
        self.assertEqual(self.request('/api/device-check', {**body, 'scanId': latest['scanId']},
                                      origin, method='POST')[0], 202)
        self.assertEqual(self.wait_for_check()['status'], 'complete')
        self.assertTrue(all(ip == '192.168.50.46' for ip, _ in self.check_calls))

    def test_device_check_scan_id_must_match_live_and_latest_saved_results(self):
        first = self.save_check_snapshot()
        latest = self.save_check_snapshot()
        peer = next(item for item in latest['devices'] if item['kind'] == 'device')
        body = {'networkId': latest['networkId'], 'deviceKey': peer['deviceKey'],
                'scanId': latest['scanId'], 'authorized': True}
        with self.server.state.lock:
            self.server.state.result = first
        self.assertEqual(self.request('/api/device-check', body, {'Origin': self.base}, method='POST')[0], 400)
        self.assertEqual(self.check_calls, [])

    def test_invalid_scan_id_is_rejected_even_while_a_check_is_running(self):
        saved = self.save_check_snapshot()
        peer = next(item for item in saved['devices'] if item['kind'] == 'device')
        body = {'networkId': saved['networkId'], 'deviceKey': peer['deviceKey'],
                'scanId': saved['scanId'], 'authorized': True}
        origin = {'Origin': self.base}
        self.check_gate.clear()
        status, started = self.request('/api/device-check', body, origin, method='POST')
        self.assertEqual(status, 202)
        self.wait_for_check_calls(1)
        for invalid in (None, True, False, 0, -1, 1.0, '1', [], {}):
            with self.subTest(scanId=invalid):
                self.assertEqual(self.request('/api/device-check', {**body, 'scanId': invalid},
                                              origin, method='POST')[0], 400)
        self.assertEqual(self.request('/api/device-check/cancel', {'runId': started['runId']},
                                      origin, method='POST'), (200, {'cancelled': True}))
        self.check_gate.set()
        self.assertEqual(self.wait_for_check()['status'], 'cancelled')
        self.assertEqual(len(self.check_calls), 1)

    def test_old_run_cancel_cannot_stop_a_repeat_check_of_the_same_device_and_scan(self):
        self.assertIsNone(self.request('/api/device-check')[1]['runId'])
        saved = self.save_check_snapshot()
        peer = next(item for item in saved['devices'] if item['kind'] == 'device')
        body = {'networkId': saved['networkId'], 'deviceKey': peer['deviceKey'],
                'scanId': saved['scanId'], 'authorized': True}
        origin = {'Origin': self.base}
        status, first = self.request('/api/device-check', body, origin, method='POST')
        self.assertEqual(status, 202)
        self.assertRegex(first['runId'], r'^[0-9a-f]{32}$')
        self.assertEqual(self.wait_for_check()['runId'], first['runId'])
        previous_calls = len(self.check_calls)
        self.check_gate.clear()

        def pause_after_first(ip, port):
            self.check_calls.append((ip, port))
            if port != 21:
                self.check_gate.wait(2)
            return {'status': 'closed'}

        self.server.state.port_probe = pause_after_first
        status, second = self.request('/api/device-check', body, origin, method='POST')
        self.assertEqual(status, 202)
        self.assertRegex(second['runId'], r'^[0-9a-f]{32}$')
        self.assertNotEqual(second['runId'], first['runId'])
        self.wait_for_check_calls(previous_calls + 2)
        cancel_event = self.server.state.device_check_cancel
        self.assertEqual(self.request('/api/device-check/cancel', {'runId': first['runId']},
                                      origin, method='POST'), (200, {'cancelled': False}))
        self.assertFalse(cancel_event.is_set())
        progress = self.request('/api/device-check')[1]
        self.assertEqual(progress['runId'], second['runId'])
        self.assertEqual(progress['completed'], 1)
        self.assertEqual(len(progress['results']), 1)
        self.assertEqual(self.request('/api/device-check/cancel', {'runId': second['runId']},
                                      origin, method='POST'), (200, {'cancelled': True}))
        self.check_gate.set()
        terminal = self.wait_for_check()
        self.assertEqual(terminal['status'], 'cancelled')
        self.assertEqual(terminal['runId'], second['runId'])
        self.assertEqual(len(self.check_calls), previous_calls + 2)
        self.assertEqual(self.request('/api/device-check/cancel', {'runId': second['runId']},
                                      origin, method='POST'), (200, {'cancelled': False}))

    def test_cancel_requires_only_a_well_formed_run_id_and_cannot_stop_without_it(self):
        saved = self.save_check_snapshot()
        peer = next(item for item in saved['devices'] if item['kind'] == 'device')
        body = {'networkId': saved['networkId'], 'deviceKey': peer['deviceKey'],
                'scanId': saved['scanId'], 'authorized': True}
        origin = {'Origin': self.base}
        self.check_gate.clear()
        status, check = self.request('/api/device-check', body, origin, method='POST')
        self.assertEqual(status, 202)
        self.wait_for_check_calls(1)
        cancel_event = self.server.state.device_check_cancel
        invalid_bodies = [{}, {'runId': None}, {'runId': True}, {'runId': 42},
                          {'runId': 'A' * 32}, {'runId': 'a' * 31}, {'runId': 'g' * 32},
                          {'runId': 'a' * 32 + '\n'}, {'runId': ['a' * 32]},
                          {'runId': check['runId'], 'extra': True}]
        for invalid in invalid_bodies:
            with self.subTest(body=invalid):
                self.assertEqual(self.request('/api/device-check/cancel', invalid, origin, method='POST')[0], 400)
                self.assertFalse(cancel_event.is_set())
        self.assertEqual(self.request('/api/device-check/cancel', {'runId': check['runId']},
                                      origin, method='POST'), (200, {'cancelled': True}))
        self.check_gate.set()
        self.assertEqual(self.wait_for_check()['status'], 'cancelled')
        self.assertEqual(len(self.check_calls), 1)

    def test_shutdown_cancels_current_check_internally_without_a_public_cancel_bypass(self):
        saved = self.save_check_snapshot()
        peer = next(item for item in saved['devices'] if item['kind'] == 'device')
        body = {'networkId': saved['networkId'], 'deviceKey': peer['deviceKey'],
                'scanId': saved['scanId'], 'authorized': True}
        self.check_gate.clear()
        status, started = self.request('/api/device-check', body, {'Origin': self.base}, method='POST')
        self.assertEqual(status, 202)
        self.wait_for_check_calls(1)
        cancel_event = self.server.state.device_check_cancel
        self.assertEqual(self.request('/api/shutdown', {}, method='POST')[0], 200)
        self.assertTrue(cancel_event.is_set())
        self.check_gate.set()
        self.server.state.device_check_thread.join(1)
        terminal = self.server.state.device_check_snapshot()
        self.assertEqual(terminal['status'], 'cancelled')
        self.assertEqual(terminal['runId'], started['runId'])
        self.assertEqual(len(self.check_calls), 1)

    def test_interfaces_and_initial_state(self):
        status, health = self.request('/api/health')
        self.assertEqual(status, 200)
        self.assertEqual(health['version'], '1.18.0')
        status, body = self.request('/api/interfaces')
        self.assertEqual(status, 200)
        self.assertEqual(body['interfaces'][0]['id'], '7')
        status, state = self.request('/api/state')
        self.assertEqual(state['status'], 'idle')
        self.assertIsNone(state['result'])
        self.assertIsNone(state['deviceCheck']['runId'])

    def test_data_cleanup_api_requires_exact_same_origin_confirmation_and_invalidates_state(self):
        saved = self.save_check_snapshot()
        store = self.server.state.store
        second = {**saved, 'scannedAt': '2026-11-20T15:00:00+00:00',
                  'devices': saved['devices'] + [
                      {'id': '192.168.50.46', 'ip': '192.168.50.46', 'kind': 'device',
                       'hostname': 'SYNTHETIC-PEER'}]}
        store.record_scan(second)
        self.server.state.update_profile(saved['networkId'], saved['devices'][1]['deviceKey'],
                                         {'alias': '虚构本地档案'})
        store.set_settings({'notificationsEnabled': False})
        self.server.state.result = saved
        origin = {'Origin': self.base}

        status, catalogue = self.request('/api/data-cleanup')
        self.assertEqual(status, 200)
        self.assertEqual(catalogue['networks'], [{
            'id': saved['networkId'], 'label': 'Ethernet', 'cidr': '192.168.50.0/24',
            'lastSeen': second['scannedAt'], 'deviceCount': 3, 'scanCount': 2, 'eventCount': 1,
        }])
        self.assertEqual(self.request('/api/data-cleanup', {'networkId': saved['networkId'],
                                                            'confirmed': True}, method='POST')[0], 403)
        self.assertEqual(self.request('/api/data-cleanup', {'networkId': saved['networkId'],
                                                            'confirmed': True},
                                      {'Origin': 'https://other.example'}, method='POST')[0], 403)
        self.assertEqual(self.request('/api/data-cleanup?networkId=' + saved['networkId'],
                                      headers=origin)[0], 400)
        self.assertEqual(self.request('/api/data-cleanup?extra=1',
                                      {'networkId': saved['networkId'], 'confirmed': True},
                                      origin, method='POST')[0], 400)
        for body in ({'networkId': saved['networkId'], 'confirmed': False},
                     {'networkId': saved['networkId'], 'confirmed': 1},
                     {'networkId': saved['networkId'], 'confirmed': True, 'deviceKey': 'ignored'},
                     {'networkId': '../' + 'a' * 30, 'confirmed': True},
                     {'networkId': 'f' * 32, 'confirmed': True}):
            with self.subTest(body=body):
                self.assertIn(self.request('/api/data-cleanup', body, origin, method='POST')[0],
                              (400, 404))
        self.assertEqual(len(store.list_scans(saved['networkId'])), 2)
        self.assertEqual(self.request('/api/state')[1]['dataRevision'], 0)

        status, deleted = self.request('/api/data-cleanup',
                                        {'networkId': saved['networkId'], 'confirmed': True},
                                        origin, method='POST')
        self.assertEqual(status, 200)
        self.assertEqual(deleted, {'deleted': True,
                                   'counts': {'deviceCount': 3, 'scanCount': 2, 'eventCount': 1},
                                   'dataRevision': 1})
        state = self.request('/api/state')[1]
        self.assertIsNone(state['result'])
        self.assertEqual(state['dataRevision'], 1)
        self.assertEqual(store.get_settings(), {'notificationsEnabled': False})
        self.assertEqual(store.list_networks(), [])
        self.assertEqual(self.calls, [])
        self.assertEqual(self.check_calls, [])

    def test_data_cleanup_conflicts_with_active_discovery_check_or_monitor(self):
        saved = self.save_check_snapshot()
        body = {'networkId': saved['networkId'], 'confirmed': True}
        origin = {'Origin': self.base}
        self.gate.clear()
        self.assertEqual(self.request('/api/scan', {'interfaceId': '7'})[0], 202)
        self.assertEqual(self.request('/api/data-cleanup', body, origin, method='POST')[0], 409)
        self.gate.set()
        for _ in range(100):
            if self.server.state.snapshot()['status'] != 'scanning':
                break
            time.sleep(.01)
        self.assertEqual(self.server.state.snapshot()['status'], 'complete')

        fresh = self.save_check_snapshot()
        peer = next(item for item in fresh['devices'] if item['kind'] == 'device')
        check = {'networkId': fresh['networkId'], 'deviceKey': peer['deviceKey'],
                 'scanId': fresh['scanId'], 'authorized': True}
        self.check_gate.clear()
        started = self.request('/api/device-check', check, origin, method='POST')
        self.assertEqual(started[0], 202)
        self.assertEqual(self.request('/api/data-cleanup', body, origin, method='POST')[0], 409)
        self.check_gate.set()
        self.wait_for_check()

        with mock.patch.object(self.server.state.monitor, 'snapshot',
                               return_value={'enabled': True, 'interfaceId': '7',
                                             'intervalSeconds': 60, 'nextScanAt': None, 'error': None}):
            self.assertEqual(self.request('/api/data-cleanup', body, origin, method='POST')[0], 409)

    def test_data_cleanup_does_not_clear_or_advance_revision_when_delete_rolls_back(self):
        saved = self.save_check_snapshot()
        with mock.patch.object(self.server.state.store, 'delete_network',
                               side_effect=sqlite3.IntegrityError('forced cleanup rollback')):
            with self.assertLogs('netspace', level='ERROR'):
                self.assertEqual(self.request('/api/data-cleanup',
                                              {'networkId': saved['networkId'], 'confirmed': True},
                                              {'Origin': self.base}, method='POST')[0], 503)
        state = self.request('/api/state')[1]
        self.assertEqual(state['dataRevision'], 0)
        self.assertEqual(state['result']['networkId'], saved['networkId'])
        self.assertEqual(len(self.server.state.store.list_networks()), 1)

    def test_cleanup_maintenance_blocks_new_discovery_and_device_checks(self):
        saved = self.save_check_snapshot()
        peer = next(item for item in saved['devices'] if item['kind'] == 'device')
        delete_entered, release_delete = threading.Event(), threading.Event()
        original_delete = self.server.state.store.delete_network

        def held_delete(network_id):
            delete_entered.set()
            if not release_delete.wait(3):
                raise RuntimeError('cleanup test timed out')
            return original_delete(network_id)

        response = []
        with mock.patch.object(self.server.state.store, 'delete_network', side_effect=held_delete):
            worker = threading.Thread(target=lambda: response.append(self.request(
                '/api/data-cleanup', {'networkId': saved['networkId'], 'confirmed': True},
                {'Origin': self.base}, method='POST')), daemon=True)
            worker.start()
            try:
                self.assertTrue(delete_entered.wait(2), 'cleanup should enter its protected transaction')
                self.assertTrue(self.server.state.snapshot()['maintenance'])
                self.assertEqual(self.request('/api/scan', {'interfaceId': '7'})[0], 409)
                check = {'networkId': saved['networkId'], 'deviceKey': peer['deviceKey'],
                         'scanId': saved['scanId'], 'authorized': True}
                self.assertEqual(self.request('/api/device-check', check,
                                              {'Origin': self.base}, method='POST')[0], 409)
                self.assertEqual(self.request('/api/web-header-check', check,
                                              {'Origin': self.base}, method='POST')[0], 409)
                self.assertEqual(self.calls, [])
                self.assertEqual(self.check_calls, [])
            finally:
                release_delete.set()
                worker.join(3)
        self.assertFalse(worker.is_alive(), 'cleanup request should finish after releasing the test gate')
        self.assertEqual(response[0][0], 200)
        self.assertFalse(self.server.state.snapshot()['maintenance'])
        self.assertEqual(self.server.state.snapshot()['dataRevision'], 1)

    def test_backup_download_is_integral_validated_and_keeps_internal_paths_private(self):
        store = self.server.state.store
        result = {'interface': self.interfaces[0],
                  'devices': [{'id': '192.168.50.20', 'ip': '192.168.50.20', 'kind': 'self'}],
                  'links': [], 'warnings': [], 'scope': {'cidr': '192.168.50.0/24'},
                  'scannedAt': '2026-11-20T00:00:00+00:00', 'durationMs': 1}
        saved = store.record_scan(result)
        store.update_profile(saved['networkId'], saved['devices'][0]['deviceKey'],
                             {'alias': '可导出的设备资料'})
        store.record_scan({**result, 'devices': result['devices'] + [
            {'id': '192.168.50.31', 'ip': '192.168.50.31', 'kind': 'device', 'hostname': 'NAS'}]})
        store.set_settings({'notificationsEnabled': False})

        request = urllib.request.Request(self.base + '/api/backup')
        with urllib.request.urlopen(request, timeout=3) as response:
            body = response.read()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers.get('Content-Type'), 'application/vnd.sqlite3')
            self.assertIn('attachment; filename="NetSpace-backup-', response.headers.get('Content-Disposition'))
            self.assertTrue(response.headers.get('Content-Disposition').endswith('.db"'))
            self.assertEqual(response.headers.get('Cache-Control'), 'no-store')
            self.assertEqual(response.headers.get('X-Content-Type-Options'), 'nosniff')
            self.assertEqual(int(response.headers.get('Content-Length')), len(body))
        self.assertTrue(body.startswith(b'SQLite format 3\x00'))
        with tempfile.TemporaryDirectory() as directory:
            backup_path = Path(directory) / 'download.db'
            backup_path.write_bytes(body)
            backup = sqlite3.connect(str(backup_path))
            try:
                self.assertEqual(backup.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
                self.assertEqual(backup.execute('SELECT value FROM settings WHERE key = ?',
                                                ('notificationsEnabled',)).fetchone()[0], 'false')
                self.assertIn('可导出的设备资料', backup.execute('SELECT profile FROM devices').fetchone()[0])
                self.assertGreater(backup.execute('SELECT COUNT(*) FROM scans').fetchone()[0], 1)
                self.assertEqual(backup.execute('SELECT kind FROM events').fetchone()[0], 'new')
            finally:
                backup.close()

        self.assertEqual(self.request('/api/backup?path=C:/private.db')[0], 400)
        self.assertEqual(self.request('/api/backup', headers={'Origin': 'https://other.example'})[0], 403)
        with mock.patch.object(store, 'backup_to', side_effect=RuntimeError('private filesystem path')):
            with self.assertLogs('netspace', level='ERROR'):
                status, error = self.request('/api/backup')
        self.assertEqual(status, 503)
        self.assertIn('备份', error['error'])
        self.assertNotIn('private filesystem path', error['error'])

    def test_scan_completes_and_preserves_result(self):
        status, _ = self.request('/api/scan', {'interfaceId': '7'})
        self.assertEqual(status, 202)
        for _ in range(30):
            _, state = self.request('/api/state')
            if state['status'] != 'scanning':
                break
            time.sleep(.02)
        self.assertEqual(state['status'], 'complete')
        self.assertEqual(state['result']['devices'][0]['id'], '192.168.50.20')
        self.assertEqual(self.calls, ['7'])

    def test_second_scan_is_rejected_while_running(self):
        self.gate.clear()
        self.assertEqual(self.request('/api/scan', {'interfaceId': '7'})[0], 202)
        self.assertEqual(self.request('/api/scan', {'interfaceId': '7'})[0], 409)
        self.assertEqual(len(self.calls), 1)

    def test_worker_start_failure_does_not_leave_scan_stuck(self):
        with mock.patch.object(threading.Thread, 'start', side_effect=RuntimeError('thread limit')):
            with self.assertRaisesRegex(RuntimeError, 'thread limit'):
                self.server.state.start_scan('7')
        self.assertEqual(self.server.state.snapshot()['status'], 'error')
        self.assertIn('thread limit', self.server.state.snapshot()['error'])
        self.assertTrue(self.server.state.start_scan('7'))
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and self.server.state.snapshot()['status'] == 'scanning':
            time.sleep(.02)
        self.assertEqual(self.server.state.snapshot()['status'], 'complete')

    def test_arbitrary_network_target_is_rejected(self):
        self.assertEqual(self.request('/api/scan', {'interfaceId': '8.8.8.8'})[0], 400)
        self.assertEqual(self.calls, [])

    def test_invalid_json_shape_is_rejected(self):
        self.assertEqual(self.request('/api/scan', ['7'])[0], 400)
        self.assertEqual(self.request('/api/scan', {})[0], 400)

    def test_cross_origin_and_rebinding_requests_are_rejected(self):
        self.assertEqual(self.request('/api/scan', {'interfaceId': '7'}, {'Origin': 'https://other.example'})[0], 403)
        self.assertEqual(self.request('/api/state', headers={'Host': 'other.example'})[0], 403)
        self.assertEqual(self.calls, [])

    def test_device_check_requires_same_origin_explicit_permission_and_real_saved_peer(self):
        saved = self.save_check_snapshot()
        peer = next(item for item in saved['devices'] if item['kind'] == 'device')
        body = {'networkId': saved['networkId'], 'deviceKey': peer['deviceKey'], 'scanId': saved['scanId'], 'authorized': True}
        origin = {'Origin': self.base}
        self.assertEqual(self.request('/api/device-check', body, method='POST')[0], 403)
        self.assertEqual(self.request('/api/device-check', body, {'Origin': 'https://other.example'}, method='POST')[0], 403)
        self.assertEqual(self.request('/api/device-check', {**body, 'ip': '192.168.50.45'}, origin, method='POST')[0], 400)
        self.assertEqual(self.request('/api/device-check', {**body, 'authorized': False}, origin, method='POST')[0], 400)
        self.assertEqual(self.request('/api/device-check', {**body, 'deviceKey': 'f' * 32}, origin, method='POST')[0], 404)
        self.assertEqual(self.check_calls, [])

        status, started = self.request('/api/device-check', body, origin, method='POST')
        self.assertEqual(status, 202)
        self.assertNotIn('192.168.50.45', json.dumps(started))
        result = self.wait_for_check()
        self.assertEqual([port for _, port in self.check_calls], [21, 22, 23, 80, 443, 445, 3389])
        self.assertTrue(all(ip == '192.168.50.45' for ip, _ in self.check_calls))
        self.assertEqual(result['status'], 'complete')
        self.assertEqual(result['networkId'], saved['networkId'])
        self.assertEqual(result['deviceKey'], peer['deviceKey'])
        self.assertNotIn('192.168.50.45', json.dumps(result))
        self.assertEqual(self.server.state.store.list_scans(saved['networkId'], 10)[0]['id'], saved['scanId'])

    def test_device_check_rejects_self_stale_nonprivate_and_out_of_scope_targets(self):
        from datetime import datetime, timedelta, timezone
        stale = (datetime.now(timezone.utc) - timedelta(minutes=7)).isoformat()
        saved = self.save_check_snapshot(scanned_at=stale)
        peer = next(item for item in saved['devices'] if item['kind'] == 'device')
        body = {'networkId': saved['networkId'], 'deviceKey': peer['deviceKey'], 'scanId': saved['scanId'], 'authorized': True}
        headers = {'Origin': self.base}
        self.assertEqual(self.request('/api/device-check', body, headers, method='POST')[0], 400)

        saved = self.save_check_snapshot(peer_ip=self.interfaces[0]['ip'])
        local = next(item for item in saved['devices'] if item['kind'] == 'self')
        body = {'networkId': saved['networkId'], 'deviceKey': local['deviceKey'], 'scanId': saved['scanId'], 'authorized': True}
        self.assertEqual(self.request('/api/device-check', body, headers, method='POST')[0], 400)

        saved = self.save_check_snapshot(peer_ip='192.168.51.45')
        peer = next(item for item in saved['devices'] if item['kind'] == 'device')
        body = {'networkId': saved['networkId'], 'deviceKey': peer['deviceKey'], 'scanId': saved['scanId'], 'authorized': True}
        self.assertEqual(self.request('/api/device-check', body, headers, method='POST')[0], 400)
        self.assertEqual(self.check_calls, [])

    def test_device_check_rejects_network_change_disconnected_adapter_and_historical_record(self):
        saved = self.save_check_snapshot()
        peer = next(item for item in saved['devices'] if item['kind'] == 'device')
        body = {'networkId': saved['networkId'], 'deviceKey': peer['deviceKey'], 'scanId': saved['scanId'], 'authorized': True}
        headers = {'Origin': self.base}
        self.interfaces[0]['ip'] = '192.168.60.20'
        self.assertEqual(self.request('/api/device-check', body, headers, method='POST')[0], 400)
        self.interfaces[0]['ip'] = '192.168.50.20'
        self.server.state.result = None
        self.assertEqual(self.request('/api/device-check', body, headers, method='POST')[0], 400)
        self.server.state.result = saved
        self.interfaces.clear()
        self.assertEqual(self.request('/api/device-check', body, headers, method='POST')[0], 400)
        self.assertEqual(self.check_calls, [])

    def test_device_check_rejects_network_broadcast_and_every_local_adapter_address(self):
        saved = self.save_check_snapshot(peer_ip='192.168.50.255')
        peer = next(item for item in saved['devices'] if item['kind'] == 'device')
        body = {'networkId': saved['networkId'], 'deviceKey': peer['deviceKey'], 'scanId': saved['scanId'], 'authorized': True}
        self.assertEqual(self.request('/api/device-check', body, {'Origin': self.base}, method='POST')[0], 400)
        saved = self.save_check_snapshot()
        self.interfaces.append({'id': '8', 'ip': '192.168.50.45', 'prefixLength': 24, 'gateway': '192.168.50.1'})
        peer = next(item for item in saved['devices'] if item['kind'] == 'device')
        body = {'networkId': saved['networkId'], 'deviceKey': peer['deviceKey'], 'scanId': saved['scanId'], 'authorized': True}
        self.assertEqual(self.request('/api/device-check', body, {'Origin': self.base}, method='POST')[0], 400)
        self.assertEqual(self.check_calls, [])

    def test_device_check_cannot_start_while_discovering(self):
        saved = self.save_check_snapshot()
        peer = next(item for item in saved['devices'] if item['kind'] == 'device')
        body = {'networkId': saved['networkId'], 'deviceKey': peer['deviceKey'], 'scanId': saved['scanId'], 'authorized': True}
        self.gate.clear()
        self.assertEqual(self.request('/api/scan', {'interfaceId': '7'})[0], 202)
        self.assertEqual(self.request('/api/device-check', body, {'Origin': self.base}, method='POST')[0], 409)
        self.assertEqual(self.check_calls, [])

    def test_device_check_default_probe_receives_validated_source_address(self):
        saved = self.save_check_snapshot()
        peer = next(item for item in saved['devices'] if item['kind'] == 'device')
        body = {'networkId': saved['networkId'], 'deviceKey': peer['deviceKey'], 'scanId': saved['scanId'], 'authorized': True}
        self.server.state.port_probe = None
        with mock.patch.object(self.app, 'probe_tcp_port', return_value={'status': 'open'}) as probe:
            self.assertEqual(self.request('/api/device-check', body, {'Origin': self.base}, method='POST')[0], 202)
            completed = self.wait_for_check()
            self.assertEqual(completed['status'], 'complete')
            self.assertEqual(completed['scanId'], saved['scanId'])
            self.assertEqual(probe.call_args_list, [
                mock.call('192.168.50.45', port, source_ip='192.168.50.20')
                for port in (21, 22, 23, 80, 443, 445, 3389)])

    def test_device_check_rejects_future_records_and_non_lan_addresses(self):
        saved = self.save_check_snapshot(scanned_at='2099-01-01T00:00:00Z')
        peer = next(item for item in saved['devices'] if item['kind'] == 'device')
        body = {'networkId': saved['networkId'], 'deviceKey': peer['deviceKey'], 'scanId': saved['scanId'], 'authorized': True}
        self.assertEqual(self.request('/api/device-check', body, {'Origin': self.base}, method='POST')[0], 400)
        for address in ('8.8.8.8', '127.0.0.2', '169.254.1.2', '224.0.0.1'):
            saved = self.save_check_snapshot(peer_ip=address)
            peer = next(item for item in saved['devices'] if item['kind'] == 'device')
            body = {'networkId': saved['networkId'], 'deviceKey': peer['deviceKey'], 'scanId': saved['scanId'], 'authorized': True}
            self.assertEqual(self.request('/api/device-check', body, {'Origin': self.base}, method='POST')[0], 400)
        self.assertEqual(self.check_calls, [])

    def test_device_check_rejects_duplicate_json_keys_before_any_probe(self):
        payload = b'{"authorized":false,"authorized":true}'
        request = urllib.request.Request(self.base + '/api/device-check', data=payload,
                                         headers={'Content-Type': 'application/json', 'Origin': self.base})
        with self.assertRaises(urllib.error.HTTPError) as raised:
            urllib.request.urlopen(request, timeout=3)
        with raised.exception as response:
            self.assertEqual(response.code, 400)
        self.assertEqual(self.check_calls, [])

    def test_device_check_worker_failure_allows_a_fresh_authorized_retry(self):
        saved = self.save_check_snapshot()
        peer = next(item for item in saved['devices'] if item['kind'] == 'device')
        body = {'networkId': saved['networkId'], 'deviceKey': peer['deviceKey'], 'scanId': saved['scanId'], 'authorized': True}
        with mock.patch.object(self.app.threading.Thread, 'start', side_effect=RuntimeError('cannot start')):
            with self.assertRaises(RuntimeError):
                self.server.state.start_device_check(saved['networkId'], peer['deviceKey'], saved['scanId'], True)
        failed = self.server.state.device_check_snapshot()
        self.assertEqual(failed['status'], 'error')
        self.assertRegex(failed['runId'], r'^[0-9a-f]{32}$')
        self.assertFalse(self.server.state.is_scanning())
        self.assertEqual(self.check_calls, [])
        self.assertEqual(self.request('/api/device-check', body, {'Origin': self.base}, method='POST')[0], 202)
        completed = self.wait_for_check()
        self.assertEqual(completed['status'], 'complete')
        self.assertRegex(completed['runId'], r'^[0-9a-f]{32}$')
        self.assertNotEqual(completed['runId'], failed['runId'])

    def test_close_stops_device_check_before_the_next_probe(self):
        saved = self.save_check_snapshot()
        peer = next(item for item in saved['devices'] if item['kind'] == 'device')
        body = {'networkId': saved['networkId'], 'deviceKey': peer['deviceKey'], 'scanId': saved['scanId'], 'authorized': True}
        self.check_gate.clear()
        status, started = self.request('/api/device-check', body, {'Origin': self.base}, method='POST')
        self.assertEqual(status, 202)
        for _ in range(100):
            if self.check_calls:
                break
            time.sleep(.01)
        self.server.state.close()
        self.check_gate.set()
        self.server.state.device_check_thread.join(1)
        self.assertEqual(len(self.check_calls), 1)
        self.assertEqual(self.server.state.device_check_snapshot()['status'], 'cancelled')
        self.assertEqual(self.server.state.device_check_snapshot()['runId'], started['runId'])
        with self.assertRaises(ValueError):
            self.server.state.start_device_check(saved['networkId'], peer['deviceKey'], saved['scanId'], True)

    def test_device_check_is_single_task_cancellable_and_mutually_exclusive_with_discovery(self):
        saved = self.save_check_snapshot()
        peer = next(item for item in saved['devices'] if item['kind'] == 'device')
        body = {'networkId': saved['networkId'], 'deviceKey': peer['deviceKey'], 'scanId': saved['scanId'], 'authorized': True}
        self.check_gate.clear()
        status, started = self.request('/api/device-check', body, {'Origin': self.base}, method='POST')
        self.assertEqual(status, 202)
        self.assertEqual(self.request('/api/device-check', body, {'Origin': self.base}, method='POST')[0], 409)
        self.assertEqual(self.request('/api/scan', {'interfaceId': '7'})[0], 409)
        self.wait_for_check_calls(1)
        self.assertEqual(self.request('/api/device-check/cancel', {'runId': started['runId']},
                                      {'Origin': self.base}, method='POST'), (200, {'cancelled': True}))
        self.check_gate.set()
        result = self.wait_for_check()
        self.assertEqual(result['status'], 'cancelled')
        self.assertEqual(len(self.check_calls), 1)

    def test_same_origin_request_is_accepted(self):
        self.assertEqual(self.request('/api/scan', {'interfaceId': '7'}, {'Origin': self.base})[0], 202)

    def test_static_resources_cannot_escape_web_root(self):
        self.assertEqual(self.request('/%2e%2e/app.py')[0], 404)
        self.assertEqual(self.request('/api/not-real')[0], 404)

    def test_content_security_policy_covers_api_and_import_map(self):
        page = (Path(self.app.WEB_ROOT) / 'index.html').read_bytes()
        import_maps = re.findall(rb'<script type="importmap">(.*?)</script>', page, re.DOTALL)
        self.assertEqual(len(import_maps), 1, 'page must have one stable import map for the CSP hash')
        import_hash = "'sha256-{}'".format(base64.b64encode(hashlib.sha256(import_maps[0]).digest()).decode('ascii'))
        for path in ('/api/health', '/', '/app.js', '/style.css', '/not-found'):
            request = urllib.request.Request(self.base + path)
            try:
                response = urllib.request.urlopen(request, timeout=3)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                policy = response.headers.get('Content-Security-Policy')
            self.assertIsNotNone(policy, path + ' response must send a content security policy')
            self.assertIn(import_hash, policy)
            self.assertIn("default-src 'self'", policy)
            self.assertIn("connect-src 'self'", policy)
            self.assertIn("script-src 'self'", policy)
            self.assertNotIn("'unsafe-inline'", policy.split('script-src', 1)[1].split(';', 1)[0])
            self.assertIn("object-src 'none'", policy)
            self.assertIn("base-uri 'none'", policy)
            self.assertIn("form-action 'self'", policy)
            self.assertIn("frame-ancestors 'none'", policy)

    def test_server_cannot_bind_to_external_interface(self):
        with self.assertRaises(ValueError):
            self.app.create_server(host='0.0.0.0', port=0, interfaces_provider=lambda: [], scanner=lambda *_: {})

    def test_second_instance_cannot_bind_to_same_port(self):
        with self.assertRaises(OSError):
            extra = self.app.create_server(port=self.server.server_port, interfaces_provider=lambda: [], scanner=lambda *_: {})
            extra.server_close()

    def test_shutdown_cancels_cooperative_scan(self):
        exited = threading.Event()
        def cancellable_scan(interface_id, progress):
            try:
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline:
                    progress({'phase': 'probing', 'completed': 0, 'total': 2, 'message': 'Discovering'})
                    exited.wait(.01)
            finally:
                exited.set()
            return {}
        self.server.state.scanner = cancellable_scan
        self.request('/api/scan', {'interfaceId': '7'})
        self.assertEqual(self.request('/api/shutdown', {})[0], 200)
        self.assertTrue(exited.wait(.4), 'Scan must be signalled to stop when the application exits')

    def test_scan_failure_is_reported(self):
        def failing_scan(*_):
            raise RuntimeError('adapter disconnected')
        self.server.state.scanner = failing_scan
        with self.assertLogs('netspace', level='ERROR'):
            self.request('/api/scan', {'interfaceId': '7'})
            for _ in range(30):
                _, state = self.request('/api/state')
                if state['status'] != 'scanning':
                    break
                time.sleep(.02)
        self.assertEqual(state['status'], 'error')
        self.assertIn('adapter disconnected', state['error'])


if __name__ == '__main__':
    unittest.main()
