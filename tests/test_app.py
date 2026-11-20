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
        self.interfaces = [{'id': '7', 'alias': 'Ethernet', 'ip': '192.168.50.20',
                            'prefixLength': 24, 'gateway': '192.168.50.1'}]

        def scanner(interface_id, progress):
            self.calls.append(interface_id)
            progress({'phase': 'probing', 'completed': 1, 'total': 2, 'message': 'Discovering'})
            self.gate.wait(3)
            return {'interface': self.interfaces[0], 'devices': [{'id': '192.168.50.20'}],
                    'links': [], 'warnings': [], 'scope': {'targetCount': 2}}

        self.server = self.app.create_server(port=0, interfaces_provider=lambda: self.interfaces, scanner=scanner)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = 'http://127.0.0.1:{}'.format(self.server.server_port)

    def tearDown(self):
        if hasattr(self, 'server'):
            self.gate.set()
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

    def test_interfaces_and_initial_state(self):
        status, health = self.request('/api/health')
        self.assertEqual(status, 200)
        self.assertEqual(health['version'], '1.12.0')
        status, body = self.request('/api/interfaces')
        self.assertEqual(status, 200)
        self.assertEqual(body['interfaces'][0]['id'], '7')
        status, state = self.request('/api/state')
        self.assertEqual(state['status'], 'idle')
        self.assertIsNone(state['result'])

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
