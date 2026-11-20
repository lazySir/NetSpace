import unittest
from unittest import mock

import device_check


class FakeSocket:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


class DeviceCheckTests(unittest.TestCase):
    def test_only_seven_fixed_tcp_ports_are_available(self):
        self.assertEqual(tuple(item['port'] for item in device_check.SERVICES),
                         (21, 22, 23, 80, 443, 445, 3389))

    def test_successful_connection_is_closed_and_reported_as_open(self):
        connection = FakeSocket()
        with mock.patch.object(device_check.socket, 'create_connection', return_value=connection) as connect:
            result = device_check.probe_tcp_port('192.168.50.45', 445)
        self.assertEqual(result, {'port': 445, 'service': 'SMB 文件共享', 'status': 'open'})
        connect.assert_called_once_with(('192.168.50.45', 445), timeout=0.35)
        self.assertTrue(connection.closed)

    def test_refused_connection_is_not_called_a_vulnerability(self):
        with mock.patch.object(device_check.socket, 'create_connection',
                               side_effect=ConnectionRefusedError()):
            result = device_check.probe_tcp_port('192.168.50.45', 80)
        self.assertEqual(result, {'port': 80, 'service': 'HTTP 网页服务', 'status': 'closed'})

    def test_connection_is_bound_to_the_validated_local_address(self):
        connection = FakeSocket()
        connector = mock.Mock(return_value=connection)
        device_check.probe_tcp_port('192.168.50.45', 22, connector=connector,
                                    source_ip='192.168.50.20')
        connector.assert_called_once_with(('192.168.50.45', 22), timeout=0.35,
                                          source_address=('192.168.50.20', 0))
        self.assertTrue(connection.closed)

    def test_timeout_is_reported_as_inconclusive(self):
        with mock.patch.object(device_check.socket, 'create_connection', side_effect=TimeoutError()):
            result = device_check.probe_tcp_port('192.168.50.45', 3389)
        self.assertEqual(result, {'port': 3389, 'service': 'Windows 远程桌面', 'status': 'no_response'})

    def test_arbitrary_ip_and_port_are_rejected_before_connecting(self):
        with mock.patch.object(device_check.socket, 'create_connection') as connect:
            with self.assertRaises(ValueError):
                device_check.probe_tcp_port('example.com', 80)
            with self.assertRaises(ValueError):
                device_check.probe_tcp_port('192.168.50.45', 1)
        connect.assert_not_called()


if __name__ == '__main__':
    unittest.main()
