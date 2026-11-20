"""NetSpace: a loopback-only Windows LAN map application."""
import argparse
import base64
import copy
import datetime
import hashlib
from functools import lru_cache
import ipaddress
import json
import logging
import mimetypes
import os
from pathlib import Path
import re
import sqlite3
import socket
import sys
import tempfile
import threading
from concurrent.futures import CancelledError
import urllib.request
import uuid
from urllib.parse import parse_qs, unquote, urlsplit
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


from monitoring import MonitorController
from network_store import NetworkStore
from device_check import SERVICES, probe_tcp_port
from web_header_check import CHECKS_BY_SCHEME, check_http_headers


VERSION = '1.16.0'
DEVICE_CHECK_FRESH_SECONDS = 300
RESOURCE_ROOT = Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parent))
WEB_ROOT = RESOURCE_ROOT / 'web'
LOGGER = logging.getLogger('netspace')


@lru_cache(maxsize=1)
def content_security_policy():
    """Restrict browser capabilities while allowing the exact static import map."""
    document = (WEB_ROOT / 'index.html').read_bytes()
    import_maps = re.findall(rb'<script type="importmap">(.*?)</script>', document, re.DOTALL)
    if len(import_maps) != 1:
        raise RuntimeError('NetSpace must define exactly one static import map')
    digest = base64.b64encode(hashlib.sha256(import_maps[0]).digest()).decode('ascii')
    return (
        "default-src 'self'; "
        "script-src 'self' 'sha256-{}'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; "
        "connect-src 'self'; "
        "font-src 'self'; "
        "object-src 'none'; "
        "base-uri 'none'; "
        "form-action 'self'; "
        "frame-ancestors 'none'"
    ).format(digest)


class ScanState:
    def __init__(self, interfaces_provider, scanner, store, port_probe=None, web_header_checker=None):
        self.interfaces_provider = interfaces_provider
        self.scanner = scanner
        self.lock = threading.RLock()
        self.interfaces = None
        self.status = 'idle'
        self.progress = {'phase': 'idle', 'completed': 0, 'total': 0, 'message': '准备发现设备'}
        self.result = None
        self.error = None
        self.stopping = threading.Event()
        self.scan_interface_id = None
        self.store = store
        self.port_probe = port_probe
        self.device_check = {'status': 'idle', 'completed': 0, 'total': len(SERVICES), 'results': [],
                             'networkId': None, 'deviceKey': None, 'scanId': None, 'runId': None}
        self.device_check_cancel = None
        self.device_check_thread = None
        self.web_header_check = {'status': 'idle', 'completed': 0, 'total': 0, 'results': [],
                                 'networkId': None, 'deviceKey': None, 'scanId': None, 'runId': None}
        self.web_header_check_cancel = None
        self.web_header_check_thread = None
        self.web_header_checker = web_header_checker
        self.persistence_lock = threading.RLock()
        self.monitor_settings_lock = threading.RLock()
        self.maintenance = False
        self.data_revision = 0
        self.closed = False
        self.monitor = MonitorController(self.start_scan, self.is_scanning, self.stopping.is_set)

    def get_interfaces(self):
        interfaces = self.interfaces_provider()
        with self.lock:
            self.interfaces = interfaces
        return copy.deepcopy(interfaces)

    def snapshot(self):
        with self.lock:
            snapshot = copy.deepcopy({'status': self.status, 'progress': self.progress,
                                      'result': self.result, 'error': self.error,
                                      'scanInterfaceId': self.scan_interface_id,
                                      'deviceCheck': self.device_check,
                                      'webHeaderCheck': self.web_header_check,
                                      'maintenance': self.maintenance,
                                      'dataRevision': self.data_revision})
        snapshot['monitor'] = self.monitor_snapshot()
        return snapshot

    def device_check_snapshot(self):
        with self.lock:
            return copy.deepcopy(self.device_check)

    def web_header_check_snapshot(self):
        with self.lock:
            return copy.deepcopy(self.web_header_check)

    @staticmethod
    def _task_active(value):
        return value['status'] == 'checking'

    def is_scanning(self):
        with self.lock:
            return (self.maintenance or self.status == 'scanning' or self._task_active(self.device_check) or
                    self._task_active(self.web_header_check))

    def cancel_device_check(self, run_id):
        if not isinstance(run_id, str) or re.fullmatch(r'[0-9a-f]{32}', run_id) is None:
            raise ValueError('停止检查请求缺少有效的运行标识，请刷新页面后重试。')
        with self.lock:
            if (self.device_check['status'] != 'checking' or self.device_check_cancel is None or
                    self.device_check['runId'] != run_id):
                return False
            self.device_check_cancel.set()
            return True

    def cancel_web_header_check(self, run_id):
        if not isinstance(run_id, str) or re.fullmatch(r'[0-9a-f]{32}', run_id) is None:
            raise ValueError('停止检查请求缺少有效的运行标识，请刷新页面后重试。')
        with self.lock:
            if (self.web_header_check['status'] != 'checking' or self.web_header_check_cancel is None or
                    self.web_header_check['runId'] != run_id):
                return False
            self.web_header_check_cancel.set()
            return True

    def _resolve_check_target(self, network_id, device_key, expected_scan_id):
        if (not isinstance(network_id, str) or not 1 <= len(network_id) <= 80 or
                not isinstance(device_key, str) or re.fullmatch(r'[0-9a-f]{32}', device_key) is None or
                type(expected_scan_id) is not int or expected_scan_id <= 0):
            raise ValueError('请选择本次发现列表中的设备。')
        with self.lock:
            live = copy.deepcopy(self.result)
        if not live or live.get('networkId') != network_id:
            raise ValueError('请先在当前应用中发现该网络的设备。')
        scans = self.store.list_scans(network_id, limit=1)
        if not scans:
            raise KeyError('当前网络没有已保存的发现结果，请先重新发现设备。')
        latest = scans[0]
        result = self.store.get_scan(latest['id'])
        if (not isinstance(result, dict) or result.get('networkId') != network_id or
                result.get('scanId') != latest['id']):
            raise KeyError('最新发现记录不可用，请重新发现设备。')
        if live.get('scanId') != expected_scan_id or latest['id'] != expected_scan_id:
            raise ValueError('最新发现结果已变化，请重新发现设备。')
        try:
            scanned_at = datetime.datetime.fromisoformat(result['scannedAt'].replace('Z', '+00:00'))
            if scanned_at.tzinfo is None:
                scanned_at = scanned_at.replace(tzinfo=datetime.timezone.utc)
            age = (datetime.datetime.now(datetime.timezone.utc) - scanned_at.astimezone(datetime.timezone.utc)).total_seconds()
        except (KeyError, TypeError, ValueError, AttributeError) as error:
            raise ValueError('发现记录时间无法验证，请重新发现设备。') from error
        if age < -30 or age > DEVICE_CHECK_FRESH_SECONDS:
            raise ValueError('发现结果已过期，请先重新发现设备。')
        interface = result.get('interface')
        if not isinstance(interface, dict):
            raise ValueError('无法验证设备所属的网络适配器。')
        interface_id = str(interface.get('id', ''))
        adapters = self.get_interfaces()
        adapter = next((item for item in adapters if str(item.get('id', '')) == interface_id), None)
        if adapter is None:
            raise ValueError('该发现结果不属于当前连接的网络适配器。')
        if any(adapter.get(key) != interface.get(key) for key in ('ip', 'prefixLength', 'gateway', 'mac')):
            raise ValueError('网络连接已变化，请先重新发现设备。')
        try:
            local_ip = ipaddress.IPv4Address(adapter.get('ip', ''))
            scope = ipaddress.IPv4Network(
                interface.get('scanCidr') or result.get('scope', {}).get('scanCidr') or
                interface.get('cidr') or result.get('scope', {}).get('cidr'), strict=False)
            current_scope = ipaddress.IPv4Network(
                '{}/{}'.format(local_ip, adapter['prefixLength']), strict=False)
        except (KeyError, ipaddress.AddressValueError, ipaddress.NetmaskValueError, TypeError, ValueError) as error:
            raise ValueError('无法验证本机或发现范围。') from error
        device = next((item for item in result.get('devices', [])
                       if isinstance(item, dict) and item.get('deviceKey') == device_key), None)
        if device is None:
            raise KeyError('设备不在该网络的最新发现结果中。')
        if device.get('kind') == 'self':
            raise ValueError('不能对本机执行这项检查。')
        try:
            target = ipaddress.IPv4Address(device.get('ip') or device.get('id') or '')
        except (ipaddress.AddressValueError, TypeError) as error:
            raise ValueError('设备地址无法验证，请重新发现设备。') from error
        allowed_ranges = (ipaddress.IPv4Network('10.0.0.0/8'),
                          ipaddress.IPv4Network('172.16.0.0/12'),
                          ipaddress.IPv4Network('192.168.0.0/16'))
        local_ips = {item.get('ip') for item in adapters}
        if (str(target) in local_ips or target.is_loopback or target.is_link_local or
                target.is_multicast or target.is_reserved or target.is_unspecified or
                not any(target in allowed for allowed in allowed_ranges) or
                target not in scope or target not in current_scope or
                target in (current_scope.network_address, current_scope.broadcast_address) or
                target in (scope.network_address, scope.broadcast_address)):
            raise ValueError('目标不在当前已验证的家庭或办公局域网范围内。')
        return str(target), str(local_ip), result['scanId']

    def start_device_check(self, network_id, device_key, scan_id, authorized):
        if authorized is not True:
            raise ValueError('请先确认你已获得此设备所有者授权。')
        if type(scan_id) is not int or scan_id <= 0:
            raise ValueError('发现记录标识无效，请刷新页面后重试。')
        if not self.persistence_lock.acquire(blocking=False):
            return False
        try:
            with self.lock:
                if self.stopping.is_set() or self.closed:
                    raise ValueError('应用正在退出。')
                if self.maintenance or self.status == 'scanning' or self.device_check['status'] == 'checking' or self.web_header_check['status'] == 'checking':
                    return False
                target, source_ip, scan_id = self._resolve_check_target(network_id, device_key, scan_id)
                self.web_header_check = {'status': 'idle', 'completed': 0, 'total': 0, 'results': [],
                                         'networkId': None, 'deviceKey': None, 'scanId': None, 'runId': None}
                cancel_event = threading.Event()
                self.device_check_cancel = cancel_event
                self.device_check = {'status': 'checking', 'completed': 0,
                                     'total': len(SERVICES), 'results': [],
                                     'networkId': network_id, 'deviceKey': device_key, 'scanId': scan_id,
                                     'runId': uuid.uuid4().hex}
                thread = threading.Thread(target=self._run_device_check, args=(target, source_ip, cancel_event),
                                          daemon=True, name='netspace-device-check')
                self.device_check_thread = thread
                try:
                    thread.start()
                except Exception:
                    self.device_check = {**self.device_check, 'status': 'error'}
                    self.device_check_cancel = None
                    raise
        finally:
            self.persistence_lock.release()
        return True

    def start_web_header_check(self, network_id, device_key, scan_id, authorized):
        if authorized is not True:
            raise ValueError('请先确认你已获得此设备所有者授权。')
        if type(scan_id) is not int or scan_id <= 0:
            raise ValueError('发现记录标识无效，请刷新页面后重试。')
        if not self.persistence_lock.acquire(blocking=False):
            return False
        try:
            with self.lock:
                if self.stopping.is_set() or self.closed:
                    raise ValueError('应用正在退出。')
                if self.maintenance or self.status == 'scanning' or self.device_check['status'] == 'checking' or self.web_header_check['status'] == 'checking':
                    return False
                target, source_ip, scan_id = self._resolve_check_target(network_id, device_key, scan_id)
                service = self.device_check
                if (service.get('status') != 'complete' or service.get('networkId') != network_id or
                        service.get('deviceKey') != device_key or service.get('scanId') != scan_id):
                    raise ValueError('请先完成这台设备本次发现结果对应的服务检查。')
                ports = tuple(sorted({item.get('port') for item in service.get('results', [])
                                      if isinstance(item, dict) and item.get('status') == 'open'
                                      and item.get('port') in (80, 443)}))
                if not ports:
                    raise ValueError('本次服务检查没有确认开放的网页端口，因此没有可检查的对象。')
                cancel_event = threading.Event()
                self.web_header_check_cancel = cancel_event
                self.web_header_check = {'status': 'checking', 'completed': 0, 'total': len(ports), 'results': [],
                                         'networkId': network_id, 'deviceKey': device_key, 'scanId': scan_id,
                                         'runId': uuid.uuid4().hex}
                thread = threading.Thread(target=self._run_web_header_check,
                                          args=(target, source_ip, ports, cancel_event),
                                          daemon=True, name='netspace-web-header-check')
                self.web_header_check_thread = thread
                try:
                    thread.start()
                except Exception:
                    self.web_header_check = {**self.web_header_check, 'status': 'error'}
                    self.web_header_check_cancel = None
                    raise
        finally:
            self.persistence_lock.release()
        return True

    @staticmethod
    def _safe_web_header_results(value, allowed_ports):
        if not isinstance(value, dict) or not isinstance(value.get('results'), list):
            return []
        safe = []
        for port in allowed_ports:
            scheme = 'https' if port == 443 else 'http'
            known = CHECKS_BY_SCHEME[scheme]
            item = next((entry for entry in value['results']
                         if isinstance(entry, dict) and entry.get('port') == port), None)
            if not item:
                continue
            status = item.get('status')
            if status not in {'complete', 'unavailable', 'redirect_blocked'}:
                status = 'unavailable'
            checks = []
            if status == 'complete':
                supplied = {entry.get('id'): entry.get('status') for entry in item.get('checks', [])
                            if isinstance(entry, dict)} if isinstance(item.get('checks'), list) else {}
                checks = [{'id': check['id'], 'title': check['title'],
                           'status': supplied.get(check['id']) if supplied.get(check['id']) in {'present', 'missing'} else 'unavailable',
                           'recommendation': check['recommendation']} for check in known]
            safe.append({'port': port, 'scheme': scheme, 'status': status, 'checks': checks})
        return safe

    def _run_web_header_check(self, target, source_ip, ports, cancel_event):
        completed = 0
        try:
            def progress(done, total):
                nonlocal completed
                completed = max(0, min(len(ports), int(done)))
                with self.lock:
                    if self.web_header_check_cancel is cancel_event:
                        self.web_header_check = {**self.web_header_check, 'status': 'checking',
                                                 'completed': completed, 'total': len(ports)}

            checker = self.web_header_checker or check_http_headers
            value = checker(target, source_ip, ports, cancel_event, progress=progress)
            safe_results = self._safe_web_header_results(value, ports)
            with self.lock:
                if self.web_header_check_cancel is cancel_event:
                    state = 'cancelled' if cancel_event.is_set() or self.stopping.is_set() else 'complete'
                    self.web_header_check = {**self.web_header_check, 'status': state,
                                             'completed': completed if state == 'cancelled' else len(safe_results),
                                             'total': len(ports), 'results': safe_results}
                    self.web_header_check_cancel = None
        except Exception:
            # Peer-controlled exception strings can contain addresses or response data.
            LOGGER.error('Web security header check failed')
            with self.lock:
                if self.web_header_check_cancel is cancel_event:
                    self.web_header_check = {**self.web_header_check, 'status': 'error',
                                             'completed': completed, 'total': len(ports), 'results': []}
                    self.web_header_check_cancel = None

    def _run_device_check(self, target, source_ip, cancel_event):
        results = []
        try:
            for service in SERVICES:
                if cancel_event.is_set() or self.stopping.is_set():
                    break
                try:
                    outcome = (self.port_probe(target, service['port']) if self.port_probe is not None
                               else probe_tcp_port(target, service['port'], source_ip=source_ip))
                    status = outcome.get('status') if isinstance(outcome, dict) else None
                    if status not in {'open', 'closed', 'no_response', 'unavailable'}:
                        status = 'unavailable'
                except Exception:
                    status = 'unavailable'
                results.append({'port': service['port'], 'service': service['service'], 'status': status})
                with self.lock:
                    if self.device_check_cancel is cancel_event:
                        self.device_check = {**self.device_check, 'status': 'checking', 'completed': len(results),
                                             'total': len(SERVICES), 'results': copy.deepcopy(results)}
            with self.lock:
                if self.device_check_cancel is cancel_event:
                    state = 'cancelled' if cancel_event.is_set() or self.stopping.is_set() else 'complete'
                    self.device_check = {**self.device_check, 'status': state, 'completed': len(results),
                                         'total': len(SERVICES), 'results': copy.deepcopy(results)}
                    self.device_check_cancel = None
        except Exception:
            LOGGER.exception('Device service check failed')
            with self.lock:
                if self.device_check_cancel is cancel_event:
                    self.device_check = {**self.device_check, 'status': 'error', 'completed': len(results),
                                         'total': len(SERVICES), 'results': copy.deepcopy(results)}
                    self.device_check_cancel = None

    def monitor_snapshot(self):
        result = self.monitor.snapshot()
        result.update(self.store.get_settings())
        return result

    def configure_monitor(self, changes):
        with self.monitor_settings_lock:
            return self._configure_monitor(changes)

    def _configure_monitor(self, changes):
        allowed = {'enabled', 'interfaceId', 'intervalSeconds', 'notificationsEnabled'}
        if set(changes) - allowed:
            raise ValueError('定时发现设置无效')
        if 'notificationsEnabled' in changes and type(changes['notificationsEnabled']) is not bool:
            raise ValueError('提醒设置必须为布尔值')
        current = self.monitor.snapshot()
        settings = {key: value for key, value in changes.items() if key != 'notificationsEnabled'}
        self.monitor.validate(settings)
        if settings.get('enabled') is True or ('interfaceId' in settings and changes.get('enabled', current['enabled'])):
            interface_id = changes.get('interfaceId', current['interfaceId'])
            if interface_id not in {str(item['id']) for item in self.get_interfaces()}:
                raise ValueError('网卡不可用，请重新选择当前已连接的网卡')
        if 'notificationsEnabled' in changes:
            self.store.set_settings({'notificationsEnabled': changes['notificationsEnabled']})
        self.monitor.configure(settings)
        return self.monitor_snapshot()

    def update_profile(self, network_id, device_key, changes):
        with self.persistence_lock:
            profile = self.store.update_profile(network_id, device_key, changes)
            with self.lock:
                if self.result and self.result.get('networkId') == network_id:
                    for device in self.result.get('devices', []):
                        if device.get('deviceKey') == device_key:
                            device['profile'] = copy.deepcopy(profile)
            return profile

    def cleanup_network_data(self, network_id):
        """Remove one network after excluding scans, checks, and scheduled discovery."""
        with self.monitor_settings_lock:
            # Monitor configuration cannot change while this guard is held. A
            # running scheduled task is also visible through the scan/check state.
            if self.monitor.snapshot()['enabled']:
                return None
            with self.persistence_lock:
                with self.lock:
                    if self.stopping.is_set() or self.closed:
                        raise ValueError('应用正在退出。')
                    if (self.maintenance or self.status == 'scanning' or
                            self._task_active(self.device_check) or
                            self._task_active(self.web_header_check)):
                        return None
                    self.maintenance = True
                try:
                    counts = self.store.delete_network(network_id)
                    with self.lock:
                        if self.result and self.result.get('networkId') == network_id:
                            self.result = None
                            self.status = 'idle'
                            self.error = None
                            self.scan_interface_id = None
                            self.progress = {'phase': 'idle', 'completed': 0, 'total': 0,
                                             'message': '准备发现设备'}
                        for key, cancel_field in (('device_check', 'device_check_cancel'),
                                                  ('web_header_check', 'web_header_check_cancel')):
                            current = getattr(self, key)
                            if current.get('networkId') == network_id:
                                cancel = getattr(self, cancel_field)
                                if cancel is not None:
                                    cancel.set()
                                setattr(self, key, {'status': 'idle', 'completed': 0, 'total': 0,
                                                    'results': [], 'networkId': None, 'deviceKey': None,
                                                    'scanId': None, 'runId': None})
                                setattr(self, cancel_field, None)
                        self.data_revision += 1
                        revision = self.data_revision
                    return {'counts': counts, 'dataRevision': revision}
                finally:
                    with self.lock:
                        self.maintenance = False

    def close(self):
        self.stopping.set()
        with self.lock:
            if self.device_check_cancel is not None:
                self.device_check_cancel.set()
            if self.web_header_check_cancel is not None:
                self.web_header_check_cancel.set()
        self.monitor.close()
        # An in-progress scanner can finish later, but cannot save after close.
        with self.persistence_lock:
            if not self.closed:
                self.closed = True
                self.store.close()

    def start_scan(self, interface_id):
        if self.stopping.is_set():
            raise ValueError('应用正在退出')
        if not isinstance(interface_id, str) or not interface_id.isdecimal():
            raise ValueError('请选择当前已连接的网卡')
        with self.lock:
            if self.stopping.is_set():
                raise ValueError('应用正在退出')
            if self.maintenance or self.status == 'scanning' or self.device_check['status'] == 'checking' or self.web_header_check['status'] == 'checking':
                return False
            if self.interfaces is None:
                self.get_interfaces()
            if interface_id not in {str(item['id']) for item in self.interfaces}:
                raise ValueError('网卡不可用，请刷新页面后重新选择')
            self.status = 'scanning'
            self.scan_interface_id = interface_id
            self.error = None
            self.progress = {'phase': 'discovering', 'completed': 0, 'total': 0, 'message': '正在读取当前网络'}
            thread = threading.Thread(target=self._scan, args=(interface_id,), daemon=True, name='netspace-scan')
            try:
                thread.start()
            except Exception as error:
                self.status = 'error'
                self.error = str(error) or '无法启动设备发现任务，请稍后重试'
                self.progress = {'phase': 'error', 'completed': 0, 'total': 0, 'message': self.error}
                raise
        return True

    def _progress(self, progress):
        if self.stopping.is_set():
            raise CancelledError('Application is stopping')
        with self.lock:
            self.progress = dict(progress)

    def _scan(self, interface_id):
        try:
            result = self.scanner(interface_id, self._progress)
            with self.persistence_lock:
                if self.stopping.is_set():
                    raise CancelledError('Application is stopping')
                try:
                    result = self.store.record_scan(result)
                except Exception:
                    LOGGER.exception('Completed scan could not be saved')
                    result = copy.deepcopy(result)
                    result.setdefault('warnings', []).append('本次结果未保存，请检查本地存储空间；仍可查看和导出本次发现。')
                with self.lock:
                    self.result = result
                    self.status = 'complete'
                    count = result.get('scope', {}).get('targetCount', 0)
                    self.progress = {'phase': 'complete', 'completed': count, 'total': count, 'message': '设备发现完成'}
            LOGGER.info('Scan complete: interface=%s devices=%s', interface_id, len(result.get('devices', [])))
        except CancelledError:
            LOGGER.info('Scan cancelled during application shutdown')
            with self.lock:
                self.status = 'idle'
                self.progress = {'phase': 'cancelled', 'completed': 0, 'total': 0, 'message': '发现已停止'}
        except Exception as error:
            LOGGER.exception('Scan failed')
            with self.lock:
                self.status = 'error'
                self.error = str(error) or '设备发现失败，请检查网络连接后重试'
                self.progress = {'phase': 'error', 'completed': 0, 'total': 0, 'message': self.error}


class NetSpaceServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, address, state):
        self.state = state
        super().__init__(address, RequestHandler)

    def server_bind(self):
        if os.name == 'nt':
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def get_request(self):
        request, address = super().get_request()
        request.settimeout(8)
        return request, address

    def server_close(self):
        self.state.close()
        super().server_close()


class RequestHandler(BaseHTTPRequestHandler):
    server_version = 'NetSpace/' + VERSION

    def log_message(self, format_string, *args):
        LOGGER.debug(format_string, *args)

    def _respond(self, status, data, content_type='application/json; charset=utf-8'):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8') if isinstance(data, (dict, list)) else data
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', content_security_policy())
        self.send_header('Connection', 'close')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _respond_file(self, path, filename, content_type):
        size = os.path.getsize(path)
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(size))
        self.send_header('Content-Disposition', 'attachment; filename="{}"'.format(filename))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', content_security_policy())
        self.send_header('Connection', 'close')
        self.end_headers()
        try:
            with open(path, 'rb') as backup_file:
                while True:
                    chunk = backup_file.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except OSError:
            LOGGER.exception('Cannot stream local database backup')
            self.close_connection = True

    def _send_backup(self):
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S-%f')
        filename = 'NetSpace-backup-{}.db'.format(stamp)
        try:
            with tempfile.TemporaryDirectory(prefix='netspace-backup-') as directory:
                path = os.path.join(directory, filename)
                destination = sqlite3.connect(path, timeout=15)
                try:
                    self.server.state.store.backup_to(destination)
                    if destination.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                        raise sqlite3.DatabaseError('Backup integrity check failed')
                finally:
                    destination.close()
                self._respond_file(path, filename, 'application/vnd.sqlite3')
        except Exception:
            LOGGER.exception('Cannot create local database backup')
            self._respond(503, {'error': '无法生成本地数据备份，请稍后重试。'})

    def _trusted(self):
        port = self.server.server_port
        allowed_hosts = {'127.0.0.1:{}'.format(port), 'localhost:{}'.format(port)}
        if self.headers.get('Host', '').lower() not in allowed_hosts:
            self._respond(403, {'error': '仅允许从本机页面访问'})
            return False
        origin = self.headers.get('Origin')
        if origin is not None and origin not in {'http://' + value for value in allowed_hosts}:
            self._respond(403, {'error': '请求来源与当前应用不一致'})
            return False
        if self.headers.get('Sec-Fetch-Site') == 'cross-site':
            self._respond(403, {'error': '不允许跨站请求'})
            return False
        return True

    def do_GET(self):
        if not self._trusted():
            return
        path = urlsplit(self.path).path
        if path == '/api/health':
            self._respond(200, {'app': 'NetSpace', 'version': VERSION})
        elif path == '/api/device-check':
            self._respond(200, self.server.state.device_check_snapshot())
        elif path == '/api/web-header-check':
            self._respond(200, self.server.state.web_header_check_snapshot())
        elif path == '/api/backup':
            if urlsplit(self.path).query:
                self._respond(400, {'error': '备份接口不接受查询参数'})
            else:
                self._send_backup()
        elif path == '/api/interfaces':
            try:
                self._respond(200, {'interfaces': self.server.state.get_interfaces(), 'error': None})
            except Exception as error:
                LOGGER.exception('Interface enumeration failed')
                self._respond(503, {'interfaces': [], 'error': str(error)})
        elif path == '/api/state':
            self._respond(200, self.server.state.snapshot())
        elif path == '/api/data-cleanup':
            if urlsplit(self.path).query:
                self._respond(400, {'error': '清理目录不接受查询参数'})
            else:
                try:
                    self._respond(200, {'networks': self.server.state.store.list_network_cleanup_counts()})
                except Exception:
                    LOGGER.exception('Cannot read local cleanup catalogue')
                    self._respond(503, {'error': '读取本地网络清理目录失败，请稍后重试'})
        elif path in ('/api/networks', '/api/history', '/api/devices', '/api/events', '/api/monitor') or path.startswith('/api/history/'):
            self._get_workspace(path)
        elif path.startswith('/api/'):
            self._respond(404, {'error': '接口不存在'})
        else:
            self._serve_static(path)

    def _get_workspace(self, path):
        try:
            query = parse_qs(urlsplit(self.path).query, keep_blank_values=True)
            if any(len(values) != 1 for values in query.values()):
                raise ValueError('查询参数重复')
            network_id = query.get('networkId', [None])[0]
            limit_text = query.get('limit', ['50'])[0]
            if not limit_text.isdecimal() or not 1 <= int(limit_text) <= 200:
                raise ValueError('记录数量必须在 1 到 200 之间')
            limit = int(limit_text)
            store = self.server.state.store
            if path == '/api/networks':
                data = {'networks': store.list_networks()}
            elif path == '/api/history':
                data = {'scans': store.list_scans(network_id, limit)}
            elif path.startswith('/api/history/'):
                scan_id = path[len('/api/history/'):]
                if not scan_id.isdecimal() or int(scan_id) <= 0:
                    raise ValueError('历史记录编号无效')
                result = store.get_scan(int(scan_id))
                if result is None:
                    raise KeyError('历史记录不存在')
                data = {'result': result}
            elif path == '/api/devices':
                if not network_id:
                    raise ValueError('请选择网络')
                data = {'devices': store.get_devices(network_id)}
            elif path == '/api/events':
                data = {'events': store.list_events(network_id, limit),
                        'unreadCount': store.unread_count(network_id),
                        'notificationsEnabled': store.get_settings()['notificationsEnabled']}
            else:
                data = self.server.state.monitor_snapshot()
            self._respond(200, data)
        except ValueError as error:
            self._respond(400, {'error': str(error)})
        except KeyError:
            self._respond(404, {'error': '记录不存在或已清理'})
        except Exception:
            LOGGER.exception('Cannot read saved workspace')
            self._respond(503, {'error': '读取本地记录失败，请稍后重试'})

    def _serve_static(self, path):
        try:
            relative = unquote(path).lstrip('/') or 'index.html'
            target = (WEB_ROOT / relative).resolve()
            target.relative_to(WEB_ROOT.resolve())
            if not target.is_file():
                raise ValueError('not a file')
            suffix = target.suffix.lower()
            media = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html',
                     '.svg': 'image/svg+xml'}.get(suffix, mimetypes.guess_type(str(target))[0] or 'application/octet-stream')
            if suffix in ('.js', '.css', '.html', '.svg'):
                media += '; charset=utf-8'
            self._respond(200, target.read_bytes(), media)
        except (OSError, ValueError):
            self._respond(404, {'error': '页面不存在'})

    def do_POST(self):
        if not self._trusted():
            return
        path = urlsplit(self.path).path
        if path not in ('/api/scan', '/api/shutdown', '/api/profile', '/api/events/read',
                        '/api/monitor', '/api/device-check', '/api/device-check/cancel',
                        '/api/web-header-check', '/api/web-header-check/cancel',
                        '/api/data-cleanup'):
            self._respond(404, {'error': '接口不存在'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 16384:
                raise ValueError('请求内容为空或过大')
            if self.headers.get_content_type() != 'application/json':
                raise ValueError('请求需要使用 JSON 格式')
            def reject_duplicate_keys(pairs):
                output = {}
                for key, value in pairs:
                    if key in output:
                        raise ValueError('请求中包含重复字段')
                    output[key] = value
                return output

            data = json.loads(self.rfile.read(length).decode('utf-8'), object_pairs_hook=reject_duplicate_keys)
            if not isinstance(data, dict):
                raise ValueError('请求格式错误')
        except (ValueError, UnicodeDecodeError) as error:
            self._respond(400, {'error': str(error)})
            return
        if path == '/api/shutdown':
            self.server.state.stopping.set()
            with self.server.state.lock:
                if self.server.state.device_check_cancel is not None:
                    self.server.state.device_check_cancel.set()
                if self.server.state.web_header_check_cancel is not None:
                    self.server.state.web_header_check_cancel.set()
            self.server.state.monitor.close()
            self._respond(200, {'status': 'stopped'})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        try:
            if path == '/api/data-cleanup':
                expected_origin = 'http://' + self.headers.get('Host', '').lower()
                if self.headers.get('Origin') != expected_origin:
                    self._respond(403, {'error': '请从当前 NetSpace 页面启动本地数据清理'})
                    return
                if urlsplit(self.path).query:
                    raise ValueError('清理请求不接受查询参数。')
                if set(data) != {'networkId', 'confirmed'} or data.get('confirmed') is not True:
                    raise ValueError('请重新选择网络并勾选永久删除确认。')
                outcome = self.server.state.cleanup_network_data(data['networkId'])
                if outcome is None:
                    self._respond(409, {'error': '当前发现、检查或定时任务结束后才能清理本地记录。'})
                else:
                    self._respond(200, {'deleted': True, **outcome})
                return
            if path in ('/api/device-check', '/api/device-check/cancel',
                        '/api/web-header-check', '/api/web-header-check/cancel'):
                expected_origin = 'http://' + self.headers.get('Host', '').lower()
                if self.headers.get('Origin') != expected_origin:
                    self._respond(403, {'error': '请从当前 NetSpace 页面启动这项检查'})
                    return
                if path == '/api/device-check/cancel':
                    if set(data) != {'runId'}:
                        raise ValueError('停止检查请求字段无效，请刷新页面后重试。')
                    cancelled = self.server.state.cancel_device_check(data['runId'])
                    self._respond(200, {'cancelled': cancelled})
                    return
                if path == '/api/web-header-check/cancel':
                    if set(data) != {'runId'}:
                        raise ValueError('停止检查请求字段无效，请刷新页面后重试。')
                    cancelled = self.server.state.cancel_web_header_check(data['runId'])
                    self._respond(200, {'cancelled': cancelled})
                    return
                if set(data) != {'networkId', 'deviceKey', 'scanId', 'authorized'}:
                    raise ValueError('检查请求字段无效，请刷新页面后重试。')
                if path == '/api/device-check':
                    started = self.server.state.start_device_check(
                        data['networkId'], data['deviceKey'], data['scanId'], data['authorized'])
                else:
                    started = self.server.state.start_web_header_check(
                        data['networkId'], data['deviceKey'], data['scanId'], data['authorized'])
                if not started:
                    self._respond(409, {'error': '请等待当前发现或检查任务结束。'})
                else:
                    snapshot = (self.server.state.device_check_snapshot() if path == '/api/device-check'
                                else self.server.state.web_header_check_snapshot())
                    self._respond(202, snapshot)
                return
            if path == '/api/profile':
                network_id, device_key = data.get('networkId'), data.get('deviceKey')
                if not isinstance(network_id, str) or not network_id or not isinstance(device_key, str) or not device_key:
                    raise ValueError('请选择已保存的设备')
                changes = {key: value for key, value in data.items() if key not in ('networkId', 'deviceKey')}
                self._respond(200, {'profile': self.server.state.update_profile(network_id, device_key, changes)})
                return
            if path == '/api/events/read':
                if set(data) == {'eventIds'}:
                    updated = self.server.state.store.acknowledge_events(data['eventIds'])
                elif set(data) == {'networkId', 'allUnread'} and data['allUnread'] is True:
                    updated = self.server.state.store.acknowledge_network_events(data['networkId'])
                else:
                    raise ValueError('请选择要标记的记录')
                self._respond(200, {'updated': updated})
                return
            if path == '/api/monitor':
                self._respond(200, self.server.state.configure_monitor(data))
                return
            started = self.server.state.start_scan(data.get('interfaceId'))
            if not started:
                self._respond(409, {'error': '正在发现设备，请稍候再试'})
            else:
                self._respond(202, self.server.state.snapshot())
        except ValueError as error:
            self._respond(400, {'error': str(error)})
        except KeyError:
            self._respond(404, {'error': '设备记录不存在，请先发现设备'})
        except Exception as error:
            LOGGER.exception('Cannot start scan')
            message = (str(error) if path == '/api/scan' else
                       '无法完成设备检查，请检查授权和最新发现结果后重试。'
                       if path.startswith(('/api/device-check', '/api/web-header-check')) else
                       '保存本地记录失败，请检查存储空间后重试')
            self._respond(503, {'error': message})

    def do_OPTIONS(self):
        self._respond(405, {'error': '不支持该请求方式'})


def create_server(host='127.0.0.1', port=8765, interfaces_provider=None, scanner=None,
                  store=None, port_probe=None, web_header_checker=None):
    if host != '127.0.0.1':
        raise ValueError('NetSpace only listens on 127.0.0.1')
    if interfaces_provider is None or scanner is None:
        from windows_network import list_interfaces, scan_network
        interfaces_provider = interfaces_provider or list_interfaces
        scanner = scanner or scan_network
    state = ScanState(interfaces_provider, scanner, store if store is not None else NetworkStore(),
                      port_probe=port_probe, web_header_checker=web_header_checker)
    try:
        return NetSpaceServer((host, port), state)
    except Exception:
        state.close()
        raise


def configure_logging():
    folder = Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'NetSpace'
    folder.mkdir(parents=True, exist_ok=True)
    from logging.handlers import RotatingFileHandler
    handler = RotatingFileHandler(str(folder / 'netspace.log'), maxBytes=1024 * 1024, backupCount=2, encoding='utf-8')
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s', handlers=[handler])


def existing_instance_url(port):
    if not port:
        return None
    base = 'http://127.0.0.1:{}'.format(port)
    try:
        # Explicitly bypass proxy configuration for this loopback health request.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(base + '/api/health', timeout=1) as response:
            payload = json.loads(response.read(512).decode('utf-8'))
            return base if payload.get('app') == 'NetSpace' else None
    except Exception:
        return None


def main():
    parser = argparse.ArgumentParser(description='NetSpace Windows LAN 3D map')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--no-browser', action='store_true')
    parser.add_argument('--data-dir', help='本地数据保存目录，默认 LOCALAPPDATA/NetSpace')
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error('--port must be between 0 and 65535')
    configure_logging()
    if os.name != 'nt':
        raise RuntimeError('此版本需要 Windows 10 或 Windows 11')
    data_dir = Path(args.data_dir) if args.data_dir else Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'NetSpace'
    data_dir.mkdir(parents=True, exist_ok=True)
    try:
        server = create_server(port=args.port, store=NetworkStore(str(data_dir / 'netspace.db')))
    except OSError:
        existing = existing_instance_url(args.port)
        if existing:
            if not args.no_browser:
                webbrowser.open(existing)
            return
        server = create_server(port=0, store=NetworkStore(str(data_dir / 'netspace.db')))
    url = 'http://127.0.0.1:{}'.format(server.server_port)
    LOGGER.info('NetSpace %s started at %s', VERSION, url)
    if sys.stdout is not None:
        print('NetSpace: ' + url, flush=True)
    if not args.no_browser:
        threading.Timer(.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever(poll_interval=.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.state.stopping.set()
        server.server_close()
        LOGGER.info('NetSpace stopped')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        LOGGER.exception('Application failed')
        if os.name == 'nt' and sys.stderr is None:
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, str(error), 'NetSpace 启动失败', 0x10)
        else:
            raise
