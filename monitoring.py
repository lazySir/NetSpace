"""Serial, stoppable scheduling for background LAN discovery."""
from datetime import datetime, timezone
import threading
import time


class MonitorController:
    def __init__(self, start_scan, is_scanning, is_stopping, monotonic=time.monotonic,
                 wall_clock=time.time, start_worker=True):
        self._start_scan = start_scan
        self._is_scanning = is_scanning
        self._is_stopping = is_stopping
        self._clock = monotonic
        self._wall_clock = wall_clock
        self._lock = threading.RLock()
        self._wake = threading.Event()
        self._closed = False
        self._enabled = False
        self._interface_id = None
        self._interval = 300
        self._due = None
        self._error = None
        self._thread = None
        if start_worker:
            self._thread = threading.Thread(target=self._run, name='netspace-monitor', daemon=True)
            self._thread.start()

    def validate(self, changes):
        if not isinstance(changes, dict) or set(changes) - {'enabled', 'interfaceId', 'intervalSeconds'}:
            raise ValueError('定时发现设置无效')
        if 'enabled' in changes and type(changes['enabled']) is not bool:
            raise ValueError('启用状态必须为布尔值')
        if 'intervalSeconds' in changes and (type(changes['intervalSeconds']) is not int
                                            or changes['intervalSeconds'] not in (60, 300, 600)):
            raise ValueError('发现间隔只能选择 1、5 或 10 分钟')
        if 'interfaceId' in changes and (not isinstance(changes['interfaceId'], str)
                                         or not changes['interfaceId'].isdecimal()):
            raise ValueError('请选择当前已连接的网卡')
        with self._lock:
            if self._closed:
                raise ValueError('应用正在退出')
            enabled = changes.get('enabled', self._enabled)
            interface_id = changes.get('interfaceId', self._interface_id)
            interval = changes.get('intervalSeconds', self._interval)
            if enabled and interface_id is None:
                raise ValueError('请选择当前已连接的网卡')
            return enabled, interface_id, interval

    def configure(self, changes):
        with self._lock:
            enabled, interface_id, interval = self.validate(changes)
            changed_target = interface_id != self._interface_id
            if not enabled:
                self._due = None
            elif not self._enabled or changed_target:
                self._due = self._clock()
            elif interval != self._interval:
                self._due = self._clock() + interval
            self._enabled, self._interface_id, self._interval = enabled, interface_id, interval
            self._error = None
            self._wake.set()
            return self.snapshot()

    def snapshot(self):
        with self._lock:
            next_scan = None
            if self._enabled and self._due is not None:
                timestamp = self._wall_clock() + max(0, self._due - self._clock())
                next_scan = datetime.fromtimestamp(timestamp, timezone.utc).isoformat()
            return {'enabled': self._enabled, 'interfaceId': self._interface_id,
                    'intervalSeconds': self._interval, 'nextScanAt': next_scan, 'error': self._error}

    def tick(self):
        # Serialize disable with the final launch check. State snapshots must never
        # call back into this controller while holding the scan-state lock.
        with self._lock:
            if (self._closed or not self._enabled or self._is_stopping()
                    or self._due is None or self._clock() < self._due or self._is_scanning()):
                return
            try:
                started = self._start_scan(self._interface_id)
            except Exception as error:
                self._error = str(error) or '定时发现失败，请检查网络连接'
                self._due = self._clock() + self._interval
            else:
                if started:
                    self._error = None
                    self._due = self._clock() + self._interval

    def _run(self):
        while True:
            self._wake.wait(1)
            self._wake.clear()
            with self._lock:
                if self._closed:
                    return
            self.tick()

    def close(self):
        with self._lock:
            self._closed = True
            self._enabled = False
            self._due = None
            self._wake.set()
        if self._thread is not None and self._thread is not threading.current_thread():
            self._thread.join(2)
