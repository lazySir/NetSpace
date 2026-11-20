import threading
import unittest

from web_header_check import CHECKS_BY_SCHEME, check_http_headers


class FakeResponse:
    def __init__(self, status, headers):
        self.status = status
        self.headers = headers

    def getheaders(self):
        return list(self.headers.items())

    def read(self, *_args, **_kwargs):
        raise AssertionError('HEAD checks must never read a response body')


class FakeConnection:
    def __init__(self, response, record):
        self.response = response
        self.record = record

    def request(self, method, path, headers):
        self.record['request'] = (method, path, headers)

    def getresponse(self):
        return self.response

    def close(self):
        self.record['closed'] = True


class WebHeaderCheckTests(unittest.TestCase):
    def run_check(self, ports=(80, 443), *, headers_by_port=None, status_by_port=None, cancel=None, target='192.168.50.45'):
        records = []
        headers_by_port = headers_by_port or {}
        status_by_port = status_by_port or {}

        def factory(scheme, host, port, timeout, source_address):
            record = {'scheme': scheme, 'host': host, 'port': port, 'timeout': timeout, 'source': source_address}
            records.append(record)
            return FakeConnection(FakeResponse(status_by_port.get(port, 200), headers_by_port.get(port, {})), record)

        progress = []
        result = check_http_headers(target, '192.168.50.20', ports, cancel or threading.Event(),
                                    progress=lambda completed, total: progress.append((completed, total)),
                                    connection_factory=factory)
        return result, records, progress

    def test_sends_one_head_request_to_each_verified_web_port_and_reads_no_body(self):
        result, records, progress = self.run_check()
        self.assertEqual(result['status'], 'complete')
        self.assertEqual(result['completed'], 2)
        self.assertEqual(result['total'], 2)
        self.assertEqual(progress, [(1, 2), (2, 2)])
        self.assertEqual(len(records), 2)
        self.assertEqual({(item['scheme'], item['host'], item['port']) for item in records},
                         {('http', '192.168.50.45', 80), ('https', '192.168.50.45', 443)})
        self.assertTrue(all(item['closed'] for item in records))
        for item in records:
            method, path, headers = item['request']
            self.assertEqual((method, path), ('HEAD', '/'))
            self.assertEqual(set(headers), {'User-Agent', 'Accept', 'Connection'})
            self.assertEqual(item['source'], ('192.168.50.20', 0))

    def test_reports_header_names_only_and_respects_hsts_scope(self):
        headers = {
            80: {'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
                 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
                 'Permissions-Policy': 'camera=()'},
            443: {'Strict-Transport-Security': 'max-age=31536000',
                  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
                  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
                  'Permissions-Policy': 'camera=()'},
        }
        result, _, _ = self.run_check(headers_by_port=headers)
        by_port = {item['port']: item for item in result['results']}
        self.assertEqual(by_port[80]['status'], 'complete')
        self.assertNotIn('hsts', {item['id'] for item in by_port[80]['checks']})
        self.assertEqual(by_port[443]['status'], 'complete')
        self.assertTrue(all(item['status'] == 'present' for group in by_port.values() for item in group['checks']))
        self.assertNotIn('max-age=31536000', repr(result))

    def test_missing_security_headers_are_reported_with_fixed_recommendations(self):
        result, _, _ = self.run_check(ports=(80,), headers_by_port={80: {}})
        self.assertEqual(len(result['results'][0]['checks']), len(CHECKS_BY_SCHEME['http']))
        self.assertTrue(all(item['status'] == 'missing' and item['recommendation']
                            for item in result['results'][0]['checks']))

    def test_redirect_is_not_followed_and_does_not_report_destination_headers(self):
        result, records, _ = self.run_check(ports=(80,), status_by_port={80: 302},
                                            headers_by_port={80: {'Location': 'http://192.168.50.1/admin',
                                                                  'X-Private-Token': 'secret'}})
        self.assertEqual(len(records), 1)
        self.assertEqual(result['results'][0]['status'], 'redirect_blocked')
        self.assertNotIn('192.168.50.1', repr(result))
        self.assertNotIn('secret', repr(result))

    def test_timeout_or_connection_failure_returns_unavailable_without_error_details(self):
        called = []

        def factory(*_args):
            called.append(True)
            raise OSError('peer 192.168.50.45 included in exception')

        result = check_http_headers('192.168.50.45', '192.168.50.20', (80,), threading.Event(),
                                    connection_factory=factory)
        self.assertEqual(result['results'][0]['status'], 'unavailable')
        self.assertNotIn('192.168.50.45', repr(result))
        self.assertEqual(called, [True])

    def test_rejects_public_loopback_invalid_and_unapproved_ports_before_connecting(self):
        for target, ports in (('127.0.0.1', (80,)), ('8.8.8.8', (443,)),
                              ('192.168.50.45', (22,)), ('192.168.50.45', (80, 80)),
                              ('not-an-ip', (80,))):
            with self.subTest(target=target, ports=ports):
                called = []
                with self.assertRaises(ValueError):
                    check_http_headers(target, '192.168.50.20', ports, threading.Event(),
                                       connection_factory=lambda *args: called.append(args))
                self.assertEqual(called, [])

    def test_cancelled_check_stops_before_opening_a_connection(self):
        cancel = threading.Event()
        cancel.set()
        called = []
        result = check_http_headers('192.168.50.45', '192.168.50.20', (80, 443), cancel,
                                    connection_factory=lambda *args: called.append(args))
        self.assertEqual(result['status'], 'cancelled')
        self.assertEqual(result['completed'], 0)
        self.assertEqual(called, [])


if __name__ == '__main__':
    unittest.main()
