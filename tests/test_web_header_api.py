import datetime
import importlib
import json
import threading
import time
import unittest
import urllib.error
import urllib.request


class WebHeaderApiTests(unittest.TestCase):
    def setUp(self):
        self.app = importlib.import_module('app')
        self.header_calls = []
        self.header_gate = threading.Event()
        self.header_gate.set()
        self.header_started = threading.Event()
        self.open_ports = {80, 443}
        self.header_result = {
            'status': 'complete', 'completed': 2, 'total': 2,
            'results': [
                {'port': 80, 'scheme': 'http', 'status': 'complete',
                 'checks': [{'id': 'csp', 'title': '内容安全策略', 'status': 'missing',
                             'recommendation': '固定建议'}], 'header_value': 'DO_NOT_RETURN'},
                {'port': 443, 'scheme': 'https', 'status': 'unavailable', 'checks': []},
            ],
            'sensitive': 'DO_NOT_RETURN',
        }
        self.interfaces = [{'id': '7', 'alias': 'Ethernet', 'ip': '192.168.50.20',
                            'prefixLength': 24, 'gateway': '192.168.50.1'}]

        def scanner(_interface_id, _progress):
            return {'interface': {**self.interfaces[0], 'cidr': '192.168.50.0/24'},
                    'devices': [
                        {'id': '192.168.50.20', 'ip': '192.168.50.20', 'kind': 'self', 'hostname': 'TEST-PC'},
                        {'id': '192.168.50.45', 'ip': '192.168.50.45', 'kind': 'device', 'hostname': 'TEST-PEER'},
                    ], 'links': [], 'warnings': [], 'scope': {'cidr': '192.168.50.0/24'},
                    'scannedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'durationMs': 1}

        def port_probe(_ip, port):
            return {'port': port, 'service': 'test',
                    'status': 'open' if port in self.open_ports else 'closed'}

        def header_checker(target, source_ip, ports, cancel_event, progress=None):
            self.header_calls.append((target, source_ip, tuple(ports)))
            self.header_started.set()
            if progress:
                progress(0, len(ports))
            self.header_gate.wait(2)
            if progress and not cancel_event.is_set():
                progress(len(ports), len(ports))
            return self.header_result

        self.header_checker = header_checker
        self.server = self.app.create_server(
            port=0, interfaces_provider=lambda: self.interfaces, scanner=scanner,
            port_probe=port_probe, web_header_checker=header_checker)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = 'http://127.0.0.1:{}'.format(self.server.server_port)
        self.saved = self.save_snapshot()
        self.peer = next(device for device in self.saved['devices'] if device['kind'] == 'device')
        self.body = {'networkId': self.saved['networkId'], 'deviceKey': self.peer['deviceKey'],
                     'scanId': self.saved['scanId'], 'authorized': True}

    def tearDown(self):
        self.header_gate.set()
        if hasattr(self, 'server'):
            self.server.state.close()
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

    def save_snapshot(self, peer_ip='192.168.50.45'):
        result = {'interface': {**self.interfaces[0], 'cidr': '192.168.50.0/24'},
                  'devices': [
                      {'id': self.interfaces[0]['ip'], 'ip': self.interfaces[0]['ip'], 'kind': 'self'},
                      {'id': peer_ip, 'ip': peer_ip, 'kind': 'device', 'hostname': 'TEST-PEER'},
                  ], 'links': [], 'warnings': [], 'scope': {'cidr': '192.168.50.0/24'},
                  'scannedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'durationMs': 1}
        saved = self.server.state.store.record_scan(result)
        with self.server.state.lock:
            self.server.state.result = saved
            self.server.state.status = 'complete'
        return saved

    def run_service_check(self):
        status, result = self.request('/api/device-check', self.body, {'Origin': self.base}, method='POST')
        self.assertEqual(status, 202)
        for _ in range(100):
            result = self.request('/api/device-check')[1]
            if result['status'] != 'checking':
                break
            time.sleep(.01)
        self.assertEqual(result['status'], 'complete')
        return result

    def wait_for_header_check(self):
        for _ in range(100):
            result = self.request('/api/web-header-check')[1]
            if result['status'] != 'checking':
                return result
            time.sleep(.01)
        self.fail('web header check did not complete')

    def test_headers_require_completed_same_device_service_evidence_and_fresh_authorization(self):
        self.assertEqual(self.request('/api/web-header-check')[1]['status'], 'idle')
        self.assertEqual(self.request('/api/web-header-check', self.body, method='POST')[0], 403)
        self.assertEqual(self.request('/api/web-header-check', self.body, {'Origin': self.base}, method='POST')[0], 400)
        self.assertEqual(self.header_calls, [])

        self.run_service_check()
        self.header_gate.clear()
        status, started = self.request('/api/web-header-check', self.body, {'Origin': self.base}, method='POST')
        self.assertEqual(status, 202)
        self.assertEqual(started['status'], 'checking')
        self.assertRegex(started['runId'], r'^[0-9a-f]{32}$')
        self.assertTrue(self.header_started.wait(1))
        self.assertEqual(self.header_calls, [('192.168.50.45', '192.168.50.20', (80, 443))])
        self.assertEqual(self.request('/api/scan', {'interfaceId': '7'})[0], 409)
        self.assertEqual(self.request('/api/device-check', self.body, {'Origin': self.base}, method='POST')[0], 409)

        self.header_gate.set()
        finished = self.wait_for_header_check()
        self.assertEqual(finished['status'], 'complete')
        self.assertNotIn('DO_NOT_RETURN', repr(finished))
        self.assertNotIn('header_value', repr(finished))
        self.assertEqual(finished['results'][0]['checks'][0]['id'], 'csp')
        self.assertEqual(finished['results'][0]['checks'][0]['status'], 'missing')
        self.assertEqual(finished['results'][0]['checks'][0]['recommendation'], '配置内容安全策略，限制页面可加载的脚本、图片与连接来源。')

    def test_only_current_confirmed_open_http_ports_are_accepted(self):
        self.open_ports.clear()
        self.run_service_check()
        self.assertEqual(self.request('/api/web-header-check', self.body, {'Origin': self.base}, method='POST')[0], 400)
        self.assertEqual(self.header_calls, [])

    def test_requires_owner_authorization_and_rejects_client_supplied_targets_or_ports(self):
        self.run_service_check()
        origin = {'Origin': self.base}
        for body in ({**self.body, 'authorized': False}, {**self.body, 'target': '192.168.50.1'},
                     {**self.body, 'ports': [80]}, {**self.body, 'authorized': 1}):
            with self.subTest(body=body):
                self.assertEqual(self.request('/api/web-header-check', body, origin, method='POST')[0], 400)
        self.assertEqual(self.header_calls, [])

    def test_cancelled_or_failed_service_observation_cannot_authorize_header_check(self):
        self.run_service_check()
        for state in ('cancelled', 'error'):
            with self.subTest(service_status=state):
                with self.server.state.lock:
                    self.server.state.device_check = {**self.server.state.device_check, 'status': state}
                self.assertEqual(self.request('/api/web-header-check', self.body,
                                              {'Origin': self.base}, method='POST')[0], 400)
        self.assertEqual(self.header_calls, [])

    def test_service_observation_does_not_authorize_a_different_scan_or_peer(self):
        self.open_ports.update({80, 443})
        self.run_service_check()
        latest = self.save_snapshot(peer_ip='192.168.50.46')
        self.body['scanId'] = latest['scanId']
        self.peer = next(device for device in latest['devices'] if device['kind'] == 'device')
        self.body['deviceKey'] = self.peer['deviceKey']
        self.assertEqual(self.request('/api/web-header-check', self.body, {'Origin': self.base}, method='POST')[0], 400)
        self.assertEqual(self.header_calls, [])

    def test_old_run_cancel_cannot_cancel_a_later_header_check(self):
        self.run_service_check()
        self.header_gate.clear()
        status, first = self.request('/api/web-header-check', self.body, {'Origin': self.base}, method='POST')
        self.assertEqual(status, 202)
        self.assertTrue(self.header_started.wait(1))
        self.assertEqual(self.request('/api/web-header-check/cancel', {'runId': first['runId']},
                                       {'Origin': self.base}, method='POST'), (200, {'cancelled': True}))
        self.header_gate.set()
        self.assertEqual(self.wait_for_header_check()['status'], 'cancelled')

        self.header_gate.clear()
        self.header_started.clear()
        status, second = self.request('/api/web-header-check', self.body, {'Origin': self.base}, method='POST')
        self.assertEqual(status, 202)
        self.assertNotEqual(first['runId'], second['runId'])
        self.assertTrue(self.header_started.wait(1))
        self.assertEqual(self.request('/api/web-header-check/cancel', {'runId': first['runId']},
                                       {'Origin': self.base}, method='POST'), (200, {'cancelled': False}))
        self.assertEqual(self.request('/api/web-header-check')[1]['status'], 'checking')
        self.header_gate.set()
        self.assertEqual(self.wait_for_header_check()['status'], 'complete')

    def test_network_change_and_incomplete_or_cancelled_service_check_cannot_start_headers(self):
        self.open_ports.clear()
        self.open_ports.add(80)
        self.run_service_check()
        self.open_ports.add(443)
        self.run_service_check()
        latest = self.save_snapshot(peer_ip='192.168.50.45')
        peer = next(device for device in latest['devices'] if device['kind'] == 'device')
        self.body.update(scanId=latest['scanId'], deviceKey=peer['deviceKey'])
        self.assertEqual(self.request('/api/web-header-check', self.body, {'Origin': self.base}, method='POST')[0], 400)
        self.assertEqual(self.header_calls, [])

    def test_close_cancels_header_task_and_blocks_new_starts(self):
        self.run_service_check()
        self.header_gate.clear()
        status, started = self.request('/api/web-header-check', self.body, {'Origin': self.base}, method='POST')
        self.assertEqual(status, 202)
        self.assertTrue(self.header_started.wait(1))
        cancel_event = self.server.state.web_header_check_cancel
        self.server.state.close()
        self.assertTrue(cancel_event.is_set())
        self.header_gate.set()
        self.server.state.web_header_check_thread.join(1)
        self.assertEqual(self.server.state.web_header_check_snapshot()['status'], 'cancelled')
        with self.assertRaises(ValueError):
            self.server.state.start_web_header_check(self.body['networkId'], self.body['deviceKey'],
                                                     self.body['scanId'], True)
        self.assertEqual(self.server.state.web_header_check_snapshot()['runId'], started['runId'])

    def test_shutdown_endpoint_cancels_header_task_and_blocks_new_starts(self):
        self.run_service_check()
        self.header_gate.clear()
        status, started = self.request('/api/web-header-check', self.body, {'Origin': self.base}, method='POST')
        self.assertEqual(status, 202)
        self.assertTrue(self.header_started.wait(1))
        cancel_event = self.server.state.web_header_check_cancel
        self.assertEqual(self.request('/api/shutdown', {}, method='POST'), (200, {'status': 'stopped'}))
        self.assertTrue(cancel_event.is_set())
        self.header_gate.set()
        self.server.state.web_header_check_thread.join(1)
        self.assertEqual(self.server.state.web_header_check_snapshot()['status'], 'cancelled')
        with self.assertRaises(ValueError):
            self.server.state.start_web_header_check(self.body['networkId'], self.body['deviceKey'],
                                                     self.body['scanId'], True)
        self.assertEqual(self.server.state.web_header_check_snapshot()['runId'], started['runId'])


if __name__ == '__main__':
    unittest.main()
