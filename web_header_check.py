"""Bounded HEAD-only security-header checks for a verified LAN device."""
import http.client
import ipaddress


TIMEOUT_SECONDS = 3.0
PORT_SCHEMES = {80: 'http', 443: 'https'}
CHECKS_BY_SCHEME = {
    'http': (
        {'id': 'csp', 'header': 'content-security-policy', 'title': '内容安全策略',
         'recommendation': '配置内容安全策略，限制页面可加载的脚本、图片与连接来源。'},
        {'id': 'nosniff', 'header': 'x-content-type-options', 'title': '文件类型保护',
         'recommendation': '设置 X-Content-Type-Options: nosniff。'},
        {'id': 'referrer', 'header': 'referrer-policy', 'title': '来源信息保护',
         'recommendation': '配置 Referrer-Policy，减少跳转时泄露来源地址。'},
        {'id': 'permissions', 'header': 'permissions-policy', 'title': '浏览器功能限制',
         'recommendation': '按需配置 Permissions-Policy，关闭不使用的浏览器功能。'},
    ),
    'https': (
        {'id': 'csp', 'header': 'content-security-policy', 'title': '内容安全策略',
         'recommendation': '配置内容安全策略，限制页面可加载的脚本、图片与连接来源。'},
        {'id': 'nosniff', 'header': 'x-content-type-options', 'title': '文件类型保护',
         'recommendation': '设置 X-Content-Type-Options: nosniff。'},
        {'id': 'referrer', 'header': 'referrer-policy', 'title': '来源信息保护',
         'recommendation': '配置 Referrer-Policy，减少跳转时泄露来源地址。'},
        {'id': 'permissions', 'header': 'permissions-policy', 'title': '浏览器功能限制',
         'recommendation': '按需配置 Permissions-Policy，关闭不使用的浏览器功能。'},
        {'id': 'hsts', 'header': 'strict-transport-security', 'title': 'HTTPS 强制传输',
         'recommendation': '确认 HTTPS 配置稳定后设置 Strict-Transport-Security。'},
    ),
}


def _validate(target, source_ip, ports):
    try:
        target_ip = ipaddress.IPv4Address(target)
        source = ipaddress.IPv4Address(source_ip)
    except (ipaddress.AddressValueError, TypeError) as error:
        raise ValueError('检查目标或本机网络地址无效。') from error
    for address in (target_ip, source):
        if (not address.is_private or address.is_loopback or address.is_link_local or
                address.is_multicast or address.is_reserved or address.is_unspecified):
            raise ValueError('检查只允许当前局域网中的单台私有 IPv4 设备。')
    if target_ip == source:
        raise ValueError('不能检查本机地址。')
    if not isinstance(ports, (tuple, list)) or not ports or len(ports) > 2:
        raise ValueError('网页检查只接受已确认开放的 HTTP 或 HTTPS 端口。')
    if any(type(port) is not int or port not in PORT_SCHEMES for port in ports) or len(set(ports)) != len(ports):
        raise ValueError('网页检查端口无效。')
    return str(target_ip), str(source), tuple(ports)


def _default_connection_factory(scheme, target, port, timeout, source_address):
    connection_type = http.client.HTTPSConnection if scheme == 'https' else http.client.HTTPConnection
    return connection_type(target, port, timeout=timeout, source_address=source_address)


def check_http_headers(target, source_ip, ports, cancel_event, progress=None, connection_factory=None):
    """Send at most one HEAD / per verified port; never read bodies or retain header values."""
    target, source_ip, ports = _validate(target, source_ip, ports)
    factory = connection_factory or _default_connection_factory
    results = []
    total = len(ports)

    for port in ports:
        if cancel_event.is_set():
            return {'status': 'cancelled', 'completed': len(results), 'total': total, 'results': results}

        scheme = PORT_SCHEMES[port]
        connection = None
        status = 'unavailable'
        checks = []
        try:
            connection = factory(scheme, target, port, TIMEOUT_SECONDS, (source_ip, 0))
            connection.request('HEAD', '/', headers={
                'User-Agent': 'NetSpace/1.15.0 (authorized local check)',
                'Accept': '*/*',
                'Connection': 'close',
            })
            response = connection.getresponse()
            if 200 <= response.status < 300:
                present = {name.lower() for name, _value in response.getheaders()}
                checks = [{
                    'id': item['id'],
                    'title': item['title'],
                    'status': 'present' if item['header'] in present else 'missing',
                    'recommendation': item['recommendation'],
                } for item in CHECKS_BY_SCHEME[scheme]]
                status = 'complete'
            elif 300 <= response.status < 400:
                # Do not include or follow the Location value.
                status = 'redirect_blocked'
        except Exception:
            # Error strings can contain target addresses and peer-controlled content.
            status = 'unavailable'
        finally:
            if connection is not None:
                try:
                    connection.close()
                except Exception:
                    pass

        results.append({'port': port, 'scheme': scheme, 'status': status, 'checks': checks})
        if progress is not None:
            progress(len(results), total)

    return {'status': 'complete', 'completed': len(results), 'total': total, 'results': results}
