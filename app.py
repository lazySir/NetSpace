"""NetSpace: a loopback-only Windows LAN map application."""
import argparse
import copy
import json
import logging
import mimetypes
import os
from pathlib import Path
import socket
import sys
import threading
from concurrent.futures import CancelledError
import urllib.request
from urllib.parse import parse_qs, unquote, urlsplit
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


from monitoring import MonitorController
from network_store import NetworkStore


VERSION = '1.3.0'
RESOURCE_ROOT = Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parent))
WEB_ROOT = RESOURCE_ROOT / 'web'
LOGGER = logging.getLogger('netspace')


class ScanState:
    def __init__(self, interfaces_provider, scanner, store):
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
        self.persistence_lock = threading.RLock()
        self.monitor_settings_lock = threading.RLock()
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
                                      'scanInterfaceId': self.scan_interface_id})
        snapshot['monitor'] = self.monitor_snapshot()
        return snapshot

    def is_scanning(self):
        with self.lock:
            return self.status == 'scanning'

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

    def close(self):
        self.stopping.set()
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
            if self.status == 'scanning':
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
            thread.start()
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
    server_version = 'NetSpace/1.1'

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
        self.send_header('Connection', 'close')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

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
        elif path == '/api/interfaces':
            try:
                self._respond(200, {'interfaces': self.server.state.get_interfaces(), 'error': None})
            except Exception as error:
                LOGGER.exception('Interface enumeration failed')
                self._respond(503, {'interfaces': [], 'error': str(error)})
        elif path == '/api/state':
            self._respond(200, self.server.state.snapshot())
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
        if path not in ('/api/scan', '/api/shutdown', '/api/profile', '/api/events/read', '/api/monitor'):
            self._respond(404, {'error': '接口不存在'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 16384:
                raise ValueError('请求内容为空或过大')
            if self.headers.get_content_type() != 'application/json':
                raise ValueError('请求需要使用 JSON 格式')
            data = json.loads(self.rfile.read(length).decode('utf-8'))
            if not isinstance(data, dict):
                raise ValueError('请求格式错误')
        except (ValueError, UnicodeDecodeError) as error:
            self._respond(400, {'error': str(error)})
            return
        if path == '/api/shutdown':
            self.server.state.stopping.set()
            self.server.state.monitor.close()
            self._respond(200, {'status': 'stopped'})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        try:
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
            message = str(error) if path == '/api/scan' else '保存本地记录失败，请检查存储空间后重试'
            self._respond(503, {'error': message})

    def do_OPTIONS(self):
        self._respond(405, {'error': '不支持该请求方式'})


def create_server(host='127.0.0.1', port=8765, interfaces_provider=None, scanner=None, store=None):
    if host != '127.0.0.1':
        raise ValueError('NetSpace only listens on 127.0.0.1')
    if interfaces_provider is None or scanner is None:
        from windows_network import list_interfaces, scan_network
        interfaces_provider = interfaces_provider or list_interfaces
        scanner = scanner or scan_network
    state = ScanState(interfaces_provider, scanner, store if store is not None else NetworkStore())
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
