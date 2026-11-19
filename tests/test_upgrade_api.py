import importlib
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request


class UpgradeApiTests(unittest.TestCase):
    def setUp(self):
        self.app = importlib.import_module('app')
        try:
            self.store_type = importlib.import_module('network_store').NetworkStore
        except ModuleNotFoundError:
            self.fail('Persistent scan repository is missing')
        self.folder = tempfile.TemporaryDirectory()
        self.database = str(Path(self.folder.name) / 'netspace.db')
        self.interfaces = [{'id': '7', 'alias': 'Ethernet', 'ip': '192.168.1.20',
                            'cidr': '192.168.1.0/24', 'prefixLength': 24,
                            'gateway': '192.168.1.1', 'mac': '02:00:00:00:00:20'}]
        self.extra = False
        self.gate = threading.Event()
        self.gate.set()
        self.calls = []
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.start_server()

    def start_server(self):
        def scanner(interface_id, progress):
            self.calls.append(interface_id)
            self.gate.wait(2)
            devices = [{'id': '192.168.1.20', 'ip': '192.168.1.20', 'mac': '02:00:00:00:00:20',
                        'kind': 'self', 'status': 'online', 'hostname': 'my-pc'}]
            if self.extra:
                devices.append({'id': '192.168.1.21', 'ip': '192.168.1.21',
                                'mac': '02:00:00:00:00:21', 'hostname': 'new-device',
                                'kind': 'device', 'status': 'resolved'})
            return {'interface': self.interfaces[0], 'devices': devices, 'links': [],
                    'warnings': [], 'scope': {'targetCount': 2},
                    'scannedAt': '2026-11-19T12:00:00Z', 'durationMs': 3}
        self.server = self.app.create_server(port=0, interfaces_provider=lambda: self.interfaces,
                                             scanner=scanner, store=self.store_type(self.database))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = 'http://127.0.0.1:{}'.format(self.server.server_port)

    def stop_server(self):
        self.gate.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def tearDown(self):
        if hasattr(self, 'server'):
            self.stop_server()
        if hasattr(self, 'folder'):
            self.folder.cleanup()

    def request(self, path, data=None, headers=None):
        payload = None if data is None else json.dumps(data, ensure_ascii=False).encode('utf-8')
        request_headers = {'Content-Type': 'application/json'}
        request_headers.update(headers or {})
        request = urllib.request.Request(self.base + path, data=payload, headers=request_headers)
        try:
            response = self.opener.open(request, timeout=3)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read().decode('utf-8'))

    def scan(self):
        self.assertEqual(self.request('/api/scan', {'interfaceId': '7'})[0], 202)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            _, state = self.request('/api/state')
            if state['status'] != 'scanning':
                self.assertEqual(state['status'], 'complete', state)
                return state['result']
            time.sleep(.01)
        self.fail('scan did not complete')

    def test_profile_history_and_restart_persistence(self):
        first = self.scan()
        identity = {'networkId': first['networkId'], 'deviceKey': first['devices'][0]['deviceKey']}
        self.assertEqual(self.request('/api/profile', dict(identity, alias='我的电脑', notes='测' * 1000))[0], 200)
        current = self.request('/api/state')[1]['result']
        self.assertEqual(current['devices'][0]['profile']['alias'], '我的电脑')
        old = self.request('/api/history/' + str(first['scanId']))[1]['result']
        self.assertEqual(old['devices'][0]['profile']['alias'], '')
        self.assertEqual(len(self.request('/api/history')[1]['scans']), 1)
        self.stop_server()
        self.start_server()
        self.assertFalse(self.request('/api/monitor')[1]['enabled'])
        records = self.request('/api/devices?networkId=' + first['networkId'])[1]['devices']
        self.assertEqual(records[0]['profile']['alias'], '我的电脑')
        second = self.scan()
        self.assertEqual(second['devices'][0]['profile']['alias'], '我的电脑')

    def test_events_baseline_mute_and_acknowledgement(self):
        first = self.scan()
        path = '/api/events?networkId=' + first['networkId']
        self.assertEqual(self.request(path)[1]['unreadCount'], 0)
        self.extra = True
        self.scan()
        body = self.request(path)[1]
        self.assertEqual(body['unreadCount'], 1)
        event = next(item for item in body['events'] if item['kind'] == 'new')
        self.assertEqual(self.request('/api/monitor', {'notificationsEnabled': False})[0], 200)
        self.assertFalse(self.request(path)[1]['notificationsEnabled'])
        self.assertEqual(self.request('/api/events/read', {'eventIds': [event['id']]})[1]['updated'], 1)
        self.assertEqual(self.request(path)[1]['unreadCount'], 0)

    def test_monitor_enables_immediate_scan_and_can_be_disabled(self):
        status, body = self.request('/api/monitor', {'enabled': True, 'interfaceId': '7', 'intervalSeconds': 60})
        self.assertEqual(status, 200)
        self.assertTrue(body['enabled'])
        deadline = time.monotonic() + 2
        while not self.calls and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertEqual(self.calls, ['7'])
        self.assertEqual(self.request('/api/state')[1]['scanInterfaceId'], '7')
        self.assertEqual(self.request('/api/monitor', {'enabled': False})[0], 200)
        self.assertIsNone(self.request('/api/monitor')[1]['nextScanAt'])

    def test_validation_and_new_routes_share_origin_protection(self):
        invalid = ({'enabled': 1}, {'intervalSeconds': 3}, {'interfaceId': 7},
                   {'notificationsEnabled': 'false'}, {'enabled': True, 'interfaceId': '9'}, {'extra': True})
        for changes in invalid:
            with self.subTest(changes=changes):
                self.assertEqual(self.request('/api/monitor', changes)[0], 400)
        for path in ('/api/monitor', '/api/profile', '/api/events/read'):
            self.assertEqual(self.request(path, {}, {'Origin': 'https://example.org'})[0], 403)
        self.assertEqual(self.request('/api/history/999')[0], 404)
        self.assertEqual(self.request('/api/history/bad')[0], 400)
        for query in ('limit=0', 'limit=201', 'limit=true'):
            self.assertEqual(self.request('/api/history?' + query)[0], 400)
        self.assertEqual(self.request('/api/events/read', {'eventIds': [True]})[0], 400)
        self.assertEqual(self.request('/api/profile', {'networkId': 'unknown', 'deviceKey': 'unknown', 'alias': 'x'})[0], 404)

    def test_storage_failure_preserves_completed_result_with_warning(self):
        def fail(_):
            raise OSError('disk full')
        self.server.state.store.record_scan = fail
        with self.assertLogs('netspace', level='ERROR'):
            result = self.scan()
        self.assertEqual(len(result['devices']), 1)
        self.assertTrue(any('未保存' in item for item in result['warnings']))

    def test_mute_and_disable_remain_available_after_adapter_disconnects(self):
        self.gate.clear()
        self.assertEqual(self.request('/api/scan', {'interfaceId': '7'})[0], 202)
        self.server.state.monitor.configure({'enabled': True, 'interfaceId': '7'})
        connected = self.interfaces
        self.interfaces = []
        try:
            self.assertEqual(self.request('/api/monitor', {'notificationsEnabled': False})[0], 200)
            self.assertEqual(self.request('/api/monitor', {'enabled': False})[0], 200)
        finally:
            self.interfaces = connected
            self.gate.set()

    def test_workspace_write_failure_has_actionable_chinese_message(self):
        result = self.scan()
        def fail(*_):
            raise OSError('database or disk is full')
        self.server.state.store.update_profile = fail
        with self.assertLogs('netspace', level='ERROR'):
            status, body = self.request('/api/profile', {
                'networkId': result['networkId'], 'deviceKey': result['devices'][0]['deviceKey'], 'alias': 'x'})
        self.assertEqual(status, 503)
        self.assertIn('保存', body['error'])
        self.assertNotIn('database', body['error'])

    def test_failed_settings_save_does_not_enable_monitor(self):
        def fail(*_):
            raise OSError('disk full')
        self.server.state.store.set_settings = fail
        with self.assertLogs('netspace', level='ERROR'):
            status, _ = self.request('/api/monitor', {
                'enabled': True, 'interfaceId': '7', 'notificationsEnabled': False})
        self.assertEqual(status, 503)
        self.assertFalse(self.server.state.monitor.snapshot()['enabled'])

    def test_invalid_monitor_change_does_not_persist_notification_change(self):
        status, _ = self.request('/api/monitor', {'intervalSeconds': 2, 'notificationsEnabled': False})
        self.assertEqual(status, 400)
        self.assertTrue(self.server.state.store.get_settings()['notificationsEnabled'])

    def test_network_read_all_reaches_older_unread_without_crossing_networks(self):
        baseline = self.scan()
        changed = json.loads(json.dumps(baseline))
        for index in range(1, 56):
            ip = '192.168.1.' + str(30 + index)
            changed['devices'].append({'id': ip, 'ip': ip, 'mac': '02:01:00:00:00:{:02X}'.format(index),
                                       'kind': 'device', 'status': 'resolved'})
        self.server.state.store.record_scan(changed)
        other = json.loads(json.dumps(baseline))
        other['interface']['cidr'] = '192.168.2.0/24'
        other['interface']['ip'] = '192.168.2.20'
        other['interface']['gateway'] = '192.168.2.1'
        other['devices'][0].update(ip='192.168.2.20', id='192.168.2.20')
        other_baseline = self.server.state.store.record_scan(other)
        other['devices'].append({'id': '192.168.2.22', 'ip': '192.168.2.22',
                                 'mac': '02:02:00:00:00:22', 'kind': 'device', 'status': 'resolved'})
        self.server.state.store.record_scan(other)
        path = '/api/events?networkId=' + baseline['networkId']
        self.assertEqual(self.request(path)[1]['unreadCount'], 55)
        self.assertEqual(len(self.request(path)[1]['events']), 50)
        payload = {'networkId': baseline['networkId'], 'allUnread': True}
        status, body = self.request('/api/events/read', payload)
        self.assertEqual(status, 200)
        self.assertEqual(body['updated'], 55)
        self.assertEqual(self.request(path)[1]['unreadCount'], 0)
        self.assertEqual(self.request('/api/events?networkId=' + other_baseline['networkId'])[1]['unreadCount'], 1)
        self.assertEqual(self.request('/api/events/read', payload)[1]['updated'], 0)
        for invalid in ({'allUnread': True}, {'networkId': baseline['networkId'], 'allUnread': False},
                        {'networkId': True, 'allUnread': True}):
            self.assertEqual(self.request('/api/events/read', invalid)[0], 400)


if __name__ == '__main__':
    unittest.main()
