import base64
import ctypes
import json
import threading
import unittest
from concurrent.futures import CancelledError
from unittest import mock

import windows_network as network


def raw_interface(**overrides):
    row = {
        'id': 12, 'alias': '无线网络', 'ip': '192.168.7.2',
        'prefixLength': 29, 'gateway': '192.168.7.1',
        'mac': '02-AA-BB-CC-DD-02', 'physicalMedium': 9,
        'hardwareInterface': True, 'connected': True, 'skipAsSource': False,
    }
    row.update(overrides)
    return row


def selected_interface(**overrides):
    return network._normalize_interfaces([raw_interface(**overrides)])[0]


class InterfaceTests(unittest.TestCase):
    def test_connected_interfaces_have_safe_scope_and_normalized_fields(self):
        rows = [
            raw_interface(prefixLength=16),
            raw_interface(id=13, ip='10.0.0.2', prefixLength=24,
                          gateway=None, physicalMedium=14),
            raw_interface(id=14, ip='172.16.0.2', prefixLength=24,
                          hardwareInterface=False),
            raw_interface(id=15, connected=False),
            raw_interface(id=16, ip='127.0.0.1'),
            raw_interface(id=17, ip='224.0.0.1'),
            raw_interface(id=18, ip='not-an-ip'),
        ]
        interfaces = network._normalize_interfaces(rows)
        self.assertEqual([item['id'] for item in interfaces], ['12', '13', '14'])
        self.assertEqual(interfaces[0], {
            'id': '12', 'alias': '无线网络', 'ip': '192.168.7.2',
            'prefixLength': 16, 'gateway': '192.168.7.1',
            'mac': '02:AA:BB:CC:DD:02', 'type': 'wifi',
            'cidr': '192.168.0.0/16', 'scanCidr': '192.168.7.0/24',
            'scopeLimited': True,
        })
        self.assertEqual(interfaces[1]['type'], 'ethernet')
        self.assertEqual(interfaces[2]['type'], 'virtual')

    def test_one_primary_address_per_interface_prefers_gateway_subnet(self):
        rows = [raw_interface(ip='169.254.1.2', prefixLength=16, gateway=None),
                raw_interface(ip='192.168.7.2')]
        self.assertEqual(network._normalize_interfaces(rows)[0]['ip'], '192.168.7.2')

    def test_invalid_mac_is_not_reported_as_device_identity(self):
        for value in (None, '', '00-00-00-00-00-00', 'ff:ff:ff:ff:ff:ff',
                      '01:00:5e:00:00:01', 'bad value'):
            with self.subTest(value=value):
                self.assertIsNone(network._normalize_mac(value))
        self.assertEqual(network._normalize_mac('AABBCCDDEE02'), 'AA:BB:CC:DD:EE:02')

    def test_json_collection_handles_singleton_and_uses_hidden_encoded_command(self):
        process = mock.Mock(returncode=0, stdout='\ufeff' + json.dumps(raw_interface()),
                            stderr='')
        with mock.patch.object(network.subprocess, 'run', return_value=process) as run:
            result = network._run_powershell(network.INTERFACE_SCRIPT)
        self.assertEqual(result, [raw_interface()])
        args, kwargs = run.call_args
        self.assertIn('-EncodedCommand', args[0])
        encoded = args[0][args[0].index('-EncodedCommand') + 1]
        self.assertIn('Get-NetIPConfiguration', base64.b64decode(encoded).decode('utf-16-le'))
        self.assertEqual(kwargs['encoding'], 'utf-8')
        self.assertEqual(kwargs['creationflags'], network.subprocess.CREATE_NO_WINDOW)
        self.assertFalse(kwargs.get('shell', False))


class ScopeAndEvidenceTests(unittest.TestCase):
    def test_wide_subnet_is_limited_to_local_slash24_for_active_probes(self):
        scope, targets = network._scan_scope(selected_interface(prefixLength=16))
        self.assertEqual(scope, {'cidr': '192.168.0.0/16',
                                'scanCidr': '192.168.7.0/24',
                                'targetCount': 253, 'limited': True})
        self.assertNotIn('192.168.7.2', targets)
        self.assertNotIn('192.168.7.0', targets)
        self.assertNotIn('192.168.7.255', targets)
        self.assertTrue(all(ip.startswith('192.168.7.') for ip in targets))

    def test_point_to_point_and_single_host_subnets_keep_valid_endpoints(self):
        _, targets = network._scan_scope(selected_interface(ip='10.0.0.0', prefixLength=31))
        self.assertEqual(targets, ['10.0.0.1'])
        _, targets = network._scan_scope(selected_interface(ip='10.0.0.1', prefixLength=32))
        self.assertEqual(targets, [])

    def test_cache_and_active_responses_preserve_honest_status_and_boundaries(self):
        interface = selected_interface(prefixLength=16)
        rows = [
            {'id': 12, 'ip': '192.168.7.3', 'mac': '02-AA-BB-CC-DD-03', 'state': 4},
            {'id': 12, 'ip': '192.168.8.4', 'mac': '02-AA-BB-CC-DD-04', 'state': 5},
            {'id': 12, 'ip': '192.168.7.2', 'mac': '02-AA-BB-CC-DD-02', 'state': 5},
            {'id': 13, 'ip': '192.168.7.5', 'mac': '02-AA-BB-CC-DD-05', 'state': 5},
            {'id': 12, 'ip': '192.169.7.6', 'mac': '02-AA-BB-CC-DD-06', 'state': 5},
            {'id': 12, 'ip': '192.168.0.0', 'mac': '02-AA-BB-CC-DD-07', 'state': 5},
            {'id': 12, 'ip': '192.168.255.255', 'mac': '02-AA-BB-CC-DD-08', 'state': 5},
            {'id': 12, 'ip': '224.0.0.1', 'mac': '02-AA-BB-CC-DD-09', 'state': 5},
            {'id': 12, 'ip': '192.168.7.9', 'mac': '00-00-00-00-00-00', 'state': 0},
        ]
        responses = [{'ip': '192.168.7.3', 'mac': '02-AA-BB-CC-DD-03', 'latencyMs': 1.2}]
        devices = network._assemble_devices(interface, rows, responses, {interface['ip']})
        by_ip = {device['ip']: device for device in devices}
        self.assertEqual(set(by_ip), {'192.168.7.1', '192.168.7.2',
                                      '192.168.7.3', '192.168.8.4'})
        self.assertEqual(by_ip['192.168.7.2']['kind'], 'self')
        self.assertEqual(by_ip['192.168.7.2']['status'], 'online')
        self.assertTrue(by_ip['192.168.7.2']['hostname'])
        self.assertEqual(by_ip['192.168.7.1']['status'], 'unverified')
        self.assertEqual(by_ip['192.168.7.1']['kind'], 'gateway')
        self.assertEqual(by_ip['192.168.7.3']['status'], 'resolved')
        self.assertEqual(by_ip['192.168.7.3']['latencyMs'], 1.2)
        self.assertGreaterEqual(len(by_ip['192.168.7.3']['evidence']), 2)
        self.assertEqual(by_ip['192.168.8.4']['status'], 'cached')
        self.assertIsNone(by_ip['192.168.8.4']['hostname'])

    def test_successful_address_resolution_does_not_claim_peer_is_online(self):
        interface = selected_interface()
        responses = [{'ip': '192.168.7.3', 'mac': '02-AA-BB-CC-DD-03', 'latencyMs': 0.1}]
        devices = network._assemble_devices(interface, [], responses, {interface['ip']})
        by_ip = {device['ip']: device for device in devices}
        self.assertEqual([device['ip'] for device in devices if device['status'] == 'online'],
                         [interface['ip']])
        self.assertEqual(by_ip['192.168.7.3']['status'], 'resolved')
        self.assertIn('本次地址解析成功（可能来自系统缓存，不保证当前在线）',
                      by_ip['192.168.7.3']['evidence'])

    def test_gateway_outside_selected_subnet_is_not_added(self):
        interface = selected_interface(gateway='10.0.0.1')
        devices = network._assemble_devices(interface, [], [], {interface['ip']})
        self.assertEqual([device['kind'] for device in devices], ['self'])

    def test_local_secondary_addresses_are_not_duplicate_remote_devices(self):
        interface = selected_interface()
        rows = [{'id': 12, 'ip': '192.168.7.4', 'mac': '02-AA-BB-CC-DD-04', 'state': 5}]
        devices = network._assemble_devices(interface, rows, [], {'192.168.7.2', '192.168.7.4'})
        self.assertNotIn('192.168.7.4', [device['ip'] for device in devices])


class NativeProbeTests(unittest.TestCase):
    def test_native_arp_passes_source_address_as_windows_32bit_ulong(self):
        captured = {}
        def fake_send(destination, source, mac_buffer, length_pointer):
            captured.update(destination=destination, source=source)
            ctypes.memmove(mac_buffer, bytes.fromhex('02AABBCCDD03'), 6)
            ctypes.cast(length_pointer, ctypes.POINTER(ctypes.c_uint32))[0] = 6
            return 0
        with mock.patch.object(network, '_load_send_arp', return_value=fake_send):
            result = network._probe_address('192.168.7.2', '192.168.7.3')
        self.assertEqual(captured['source'], int.from_bytes(bytes([192, 168, 7, 2]), 'little'))
        self.assertEqual(captured['destination'], int.from_bytes(bytes([192, 168, 7, 3]), 'little'))
        self.assertEqual(result['mac'], '02:AA:BB:CC:DD:03')
        self.assertGreaterEqual(result['latencyMs'], 0)

    def test_failed_arp_response_is_not_reported_online(self):
        with mock.patch.object(network, '_load_send_arp', return_value=lambda *args: 67):
            self.assertIsNone(network._probe_address('192.168.7.2', '192.168.7.3'))


class ScanTests(unittest.TestCase):
    def test_progress_cancellation_discards_queued_address_resolutions(self):
        interface = selected_interface()
        second_started = threading.Event()
        release_second = threading.Event()
        attempted = []
        original_shutdown = network.ThreadPoolExecutor.shutdown

        def probe(source, destination):
            attempted.append(destination)
            if len(attempted) == 2:
                second_started.set()
                self.assertTrue(release_second.wait(2), 'test must release the running call')
            return None

        def progress(event):
            if event['phase'] == 'probing' and event['completed'] == 1:
                self.assertTrue(second_started.wait(2), 'second native call must already be running')
                raise CancelledError('window closed')

        def shutdown(executor, wait=True):
            # The running call is released only once shutdown begins. Thus
            # queued tasks run deterministically unless canceled beforehand.
            release_second.set()
            return original_shutdown(executor, wait=wait)

        with mock.patch.object(network, '_read_interface_inventory',
                               return_value=([interface], {interface['ip']})), \
             mock.patch.object(network, '_read_neighbors', return_value=[]), \
             mock.patch.object(network, '_probe_address', side_effect=probe), \
             mock.patch.object(network, 'MAX_PROBE_WORKERS', 1), \
             mock.patch.object(network.ThreadPoolExecutor, 'shutdown', autospec=True,
                               side_effect=shutdown):
            with self.assertRaises(CancelledError):
                network.scan_network('12', progress)
        self.assertEqual(len(attempted), 2)

    def test_scan_excludes_secondary_local_address_from_raw_interface_inventory(self):
        rows = [raw_interface(),
                raw_interface(ip='192.168.7.4', skipAsSource=True)]
        cached_alias = {'id': 12, 'ip': '192.168.7.4',
                        'mac': '02-AA-BB-CC-DD-02', 'state': 5}
        def probe(source, destination):
            if destination == '192.168.7.4':
                return {'ip': destination, 'mac': '02:AA:BB:CC:DD:02', 'latencyMs': 0.1}
            return None
        with mock.patch.object(network, '_run_powershell', return_value=rows), \
             mock.patch.object(network, '_read_neighbors', return_value=[cached_alias]), \
             mock.patch.object(network, '_probe_address', side_effect=probe):
            result = network.scan_network('12')
        self.assertEqual(result['interface']['ip'], '192.168.7.2')
        self.assertNotIn('192.168.7.4', {device['ip'] for device in result['devices']})
        self.assertNotIn('192.168.7.4',
                         {endpoint for link in result['links']
                          for endpoint in (link['source'], link['target'])})

    def test_scan_reports_progress_and_links_only_between_present_nodes(self):
        interface = selected_interface()
        events = []
        def probe(source, destination):
            if destination == '192.168.7.3':
                return {'ip': destination, 'mac': '02:AA:BB:CC:DD:03', 'latencyMs': 0.5}
            return None
        with mock.patch.object(network, '_read_interface_inventory',
                               return_value=([interface], {interface['ip']})), \
             mock.patch.object(network, '_read_neighbors', return_value=[]), \
             mock.patch.object(network, '_probe_address', side_effect=probe):
            result = network.scan_network('12', events.append)
        self.assertEqual(result['scope']['targetCount'], 5)
        self.assertEqual(len(result['devices']), 3)
        self.assertEqual(events[0]['phase'], 'discovering')
        self.assertEqual(events[-1]['phase'], 'finishing')
        self.assertEqual(events[-1]['completed'], events[-1]['total'])
        ids = {device['id'] for device in result['devices']}
        for link in result['links']:
            self.assertIn(link['source'], ids)
            self.assertIn(link['target'], ids)
            self.assertEqual(link['kind'], 'same-subnet')
            self.assertTrue(link['inferred'])
        self.assertTrue(result['scannedAt'].endswith('+00:00'))
        self.assertGreaterEqual(result['durationMs'], 0)

    def test_unknown_or_injected_interface_id_is_rejected_before_any_probes(self):
        interface = selected_interface()
        with mock.patch.object(network, '_read_interface_inventory',
                               return_value=([interface], {interface['ip']})), \
             mock.patch.object(network, '_read_neighbors') as neighbors, \
             mock.patch.object(network, '_probe_address') as probe:
            for interface_id in ('12; Write-Host oops', '99', '012', '', 12):
                with self.subTest(interface_id=interface_id):
                    with self.assertRaises(ValueError):
                        network.scan_network(interface_id, lambda event: None)
            neighbors.assert_not_called()
            probe.assert_not_called()

    def test_cache_failure_and_wide_scope_are_visible_as_chinese_warnings(self):
        interface = selected_interface(prefixLength=16)
        with mock.patch.object(network, '_read_interface_inventory',
                               return_value=([interface], {interface['ip']})), \
             mock.patch.object(network, '_read_neighbors', side_effect=OSError('unavailable')), \
             mock.patch.object(network, '_probe_address', return_value=None):
            result = network.scan_network('12', lambda event: None)
        self.assertTrue(any('/24' in warning for warning in result['warnings']))
        self.assertTrue(any('缓存' in warning for warning in result['warnings']))


if __name__ == '__main__':
    unittest.main()
