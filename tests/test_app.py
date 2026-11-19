import importlib
import json
import threading
import time
import unittest
import urllib.error
import urllib.request
from concurrent.futures import CancelledError


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
        status, body = self.request('/api/interfaces')
        self.assertEqual(status, 200)
        self.assertEqual(body['interfaces'][0]['id'], '7')
        status, state = self.request('/api/state')
        self.assertEqual(state['status'], 'idle')
        self.assertIsNone(state['result'])

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
