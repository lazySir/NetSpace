"""Bounded, non-destructive TCP exposure checks for one authorized LAN peer."""

import errno
import ipaddress
import socket


CONNECT_TIMEOUT_SECONDS = 0.35
SERVICES = (
    {'port': 21, 'service': 'FTP 文件传输'},
    {'port': 22, 'service': 'SSH 远程登录'},
    {'port': 23, 'service': 'Telnet 远程登录'},
    {'port': 80, 'service': 'HTTP 网页服务'},
    {'port': 443, 'service': 'HTTPS 加密网页'},
    {'port': 445, 'service': 'SMB 文件共享'},
    {'port': 3389, 'service': 'Windows 远程桌面'},
)
ALLOWED_PORTS = frozenset(item['port'] for item in SERVICES)
SERVICE_NAMES = {item['port']: item['service'] for item in SERVICES}


def probe_tcp_port(ip, port, connector=None, source_ip=None):
    """Attempt one TCP handshake; send no application data and close promptly."""
    if not isinstance(ip, str) or not isinstance(port, int) or isinstance(port, bool):
        raise ValueError('检查目标格式无效。')
    if port not in ALLOWED_PORTS:
        raise ValueError('此服务检查不支持该端口。')
    try:
        ipaddress.IPv4Address(ip)
        if source_ip is not None:
            ipaddress.IPv4Address(source_ip)
    except (ValueError, TypeError) as error:
        raise ValueError('检查仅支持有效的 IPv4 地址。') from error
    connector = connector or socket.create_connection
    status = 'open'
    connection = None
    try:
        options = {'timeout': CONNECT_TIMEOUT_SECONDS}
        if source_ip is not None:
            options['source_address'] = (source_ip, 0)
        connection = connector((ip, port), **options)
    except (TimeoutError, socket.timeout):
        status = 'no_response'
    except OSError as error:
        if (isinstance(error, ConnectionRefusedError) or error.errno == errno.ECONNREFUSED or
                getattr(error, 'winerror', None) == 10061):
            status = 'closed'
        else:
            status = 'unavailable'
    finally:
        if connection is not None:
            connection.close()
    return {'port': port, 'service': SERVICE_NAMES[port], 'status': status}
