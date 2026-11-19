import importlib
import unittest


class MonitorTests(unittest.TestCase):
    def setUp(self):
        try:
            module = importlib.import_module('monitoring')
        except ModuleNotFoundError:
            self.fail('Scheduled discovery controller is missing')
        self.now = 100.0
        self.busy = False
        self.stopping = False
        self.calls = []
        self.fail_start = False
        self.decline_start = False

        def start(interface_id):
            if self.fail_start:
                raise RuntimeError('网卡已断开')
            if self.decline_start:
                return False
            self.calls.append(interface_id)
            return True

        self.monitor = module.MonitorController(
            start, lambda: self.busy, lambda: self.stopping,
            monotonic=lambda: self.now, wall_clock=lambda: 1800000000 + self.now,
            start_worker=False)

    def tearDown(self):
        if hasattr(self, 'monitor'):
            self.monitor.close()

    def test_disabled_until_enabled_and_scans_immediately(self):
        self.monitor.tick()
        self.assertEqual(self.calls, [])
        self.monitor.configure({'enabled': True, 'interfaceId': '7'})
        self.monitor.tick()
        self.assertEqual(self.calls, ['7'])
        self.assertEqual(self.monitor.snapshot()['intervalSeconds'], 300)
        self.assertIsNotNone(self.monitor.snapshot()['nextScanAt'])

    def test_interval_and_busy_deferral_do_not_overlap(self):
        self.monitor.configure({'enabled': True, 'interfaceId': '7', 'intervalSeconds': 60})
        self.busy = True
        self.monitor.tick()
        self.assertEqual(self.calls, [])
        self.busy = False
        self.monitor.tick()
        self.now += 59
        self.monitor.tick()
        self.assertEqual(len(self.calls), 1)
        self.now += 1
        self.monitor.tick()
        self.assertEqual(len(self.calls), 2)

    def test_disable_and_close_stop_future_work(self):
        self.monitor.configure({'enabled': True, 'interfaceId': '7'})
        self.monitor.configure({'enabled': False})
        self.monitor.tick()
        self.assertIsNone(self.monitor.snapshot()['nextScanAt'])
        self.monitor.configure({'enabled': True})
        self.monitor.close()
        self.monitor.tick()
        self.assertEqual(self.calls, [])
        self.assertFalse(self.monitor.snapshot()['enabled'])

    def test_application_stop_prevents_due_scan(self):
        self.monitor.configure({'enabled': True, 'interfaceId': '7'})
        self.stopping = True
        self.monitor.tick()
        self.assertEqual(self.calls, [])

    def test_callback_failure_waits_interval_then_recovers(self):
        self.monitor.configure({'enabled': True, 'interfaceId': '7', 'intervalSeconds': 60})
        self.fail_start = True
        self.monitor.tick()
        self.assertIn('断开', self.monitor.snapshot()['error'])
        self.fail_start = False
        self.monitor.tick()
        self.assertEqual(self.calls, [])
        self.now += 60
        self.monitor.tick()
        self.assertEqual(self.calls, ['7'])
        self.assertIsNone(self.monitor.snapshot()['error'])

    def test_invalid_partial_settings_leave_configuration_unchanged(self):
        for data in ({'enabled': 1}, {'intervalSeconds': True}, {'intervalSeconds': 2},
                     {'interfaceId': 7}, {'interfaceId': 'a'}, {'enabled': True}, {'extra': 1}):
            with self.subTest(data=data), self.assertRaises(ValueError):
                self.monitor.configure(data)
            self.assertFalse(self.monitor.snapshot()['enabled'])

    def test_interval_update_reschedules(self):
        self.monitor.configure({'enabled': True, 'interfaceId': '7'})
        self.monitor.tick()
        self.monitor.configure({'intervalSeconds': 60})
        self.now += 60
        self.monitor.tick()
        self.assertEqual(len(self.calls), 2)

    def test_start_race_defers_without_skipping_scheduled_scan(self):
        self.monitor.configure({'enabled': True, 'interfaceId': '7'})
        self.decline_start = True
        self.monitor.tick()
        self.assertEqual(self.calls, [])
        self.decline_start = False
        self.monitor.tick()
        self.assertEqual(self.calls, ['7'])


if __name__ == '__main__':
    unittest.main()
