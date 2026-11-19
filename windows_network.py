"""Windows IPv4 LAN discovery with factual evidence and bounded ARP probing.

Only Windows networking APIs are used. Topology edges describe inferred
same-subnet membership; they do not identify physical wiring or location.
"""

import base64
import ctypes
import datetime
import functools
import ipaddress
import json
import os
import re
import socket
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor, as_completed


MAX_PROBE_WORKERS = 64
POWERSHELL_TIMEOUT_SECONDS = 25

# The scripts are constant. Interface IDs and IP addresses are never inserted
# into executable PowerShell text. Numeric CIM values avoid localized labels.
INTERFACE_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$configurations = @(Get-NetIPConfiguration -All -ErrorAction Stop)
$rows = @(foreach ($configuration in $configurations) {
    $adapter = $configuration.NetAdapter
    if ($null -eq $adapter) { continue }
    $gateways = @($configuration.IPv4DefaultGateway | ForEach-Object { $_.NextHop })
    foreach ($address in @($configuration.IPv4Address)) {
        if ($null -eq $address) { continue }
        if ([string]::IsNullOrWhiteSpace([string]$address.IPAddress)) { continue }
        if ([uint32]$address.AddressState -lt 3) { continue }
        [PSCustomObject]@{
            id = [uint32]$configuration.InterfaceIndex
            alias = [string]$configuration.InterfaceAlias
            ip = [string]$address.IPAddress
            prefixLength = [int]$address.PrefixLength
            gateway = $(if ($gateways.Count -gt 0) { [string]$gateways[0] } else { $null })
            mac = [string]$adapter.MacAddress
            physicalMedium = [uint32]$adapter.NdisPhysicalMedium
            hardwareInterface = [bool]$adapter.HardwareInterface
            connected = ([uint32]$adapter.InterfaceOperationalStatus -eq 1)
            skipAsSource = [bool]$address.SkipAsSource
        }
    }
})
ConvertTo-Json -InputObject @($rows) -Compress -Depth 4
"""

NEIGHBOR_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$rows = @(Get-NetNeighbor -AddressFamily IPv4 -ErrorAction Stop | ForEach-Object {
    [PSCustomObject]@{
        id = [uint32]$_.InterfaceIndex
        ip = [string]$_.IPAddress
        mac = [string]$_.LinkLayerAddress
        state = [uint32]$_.State
    }
})
ConvertTo-Json -InputObject @($rows) -Compress -Depth 3
"""


class NetworkCollectionError(RuntimeError):
    """A local Windows networking command could not provide usable data."""


def _run_powershell(script):
    encoded = base64.b64encode(script.encode('utf-16-le')).decode('ascii')
    executable = os.path.join(os.environ.get('SystemRoot', r'C:\Windows'),
                              'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    try:
        process = subprocess.run(
            [executable, '-NoLogo', '-NoProfile', '-NonInteractive',
             '-EncodedCommand', encoded],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            encoding='utf-8', errors='replace',
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
            timeout=POWERSHELL_TIMEOUT_SECONDS, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise NetworkCollectionError('无法读取 Windows 网络信息，请检查网络连接后重试。') from error
    if process.returncode != 0:
        raise NetworkCollectionError('Windows 网络信息读取失败，请检查系统网络服务后重试。')
    try:
        data = json.loads(process.stdout.lstrip('\ufeff').strip() or '[]')
    except (TypeError, ValueError) as error:
        raise NetworkCollectionError('Windows 返回的网络信息无法解析。') from error
    if data is None:
        return []
    if isinstance(data, dict):
        return [data]
    if isinstance(data, list) and all(isinstance(row, dict) for row in data):
        return data
    raise NetworkCollectionError('Windows 返回的网络信息格式不正确。')


def _normalize_mac(value):
    if not isinstance(value, str):
        return None
    compact = value.strip().replace(':', '').replace('-', '')
    if re.fullmatch(r'[0-9A-Fa-f]{12}', compact) is None:
        return None
    octets = bytes.fromhex(compact)
    if octets == b'\x00' * 6 or octets[0] & 1:
        return None
    return ':'.join('{:02X}'.format(value) for value in octets)


def _unicast_address(value):
    try:
        address = ipaddress.IPv4Address(value)
    except (ValueError, TypeError, ipaddress.AddressValueError):
        return None
    if (address.is_multicast or address.is_loopback or address.is_unspecified
            or address.is_reserved or int(address) < 0x01000000):
        return None
    return address


def _is_subnet_host(address, subnet):
    return (address is not None and address in subnet and
            (subnet.prefixlen >= 31 or address not in
             (subnet.network_address, subnet.broadcast_address)))


def _normalize_interface_inventory(rows):
    candidates = []
    for row in rows:
        if row.get('connected') is not True:
            continue
        try:
            index = int(row['id'])
            prefix = int(row['prefixLength'])
            if not 0 < index < 2 ** 32 or not 0 <= prefix <= 32:
                continue
            address = _unicast_address(row.get('ip'))
            if address is None:
                continue
            subnet = ipaddress.IPv4Network((str(address), prefix), strict=False)
            if not _is_subnet_host(address, subnet):
                continue
        except (KeyError, TypeError, ValueError):
            continue
        active_subnet = (ipaddress.IPv4Network((str(address), 24), strict=False)
                         if prefix < 24 else subnet)
        gateway = _unicast_address(row.get('gateway'))
        medium = row.get('physicalMedium')
        if not row.get('hardwareInterface', False):
            interface_type = 'virtual'
        elif medium in (1, 9):
            interface_type = 'wifi'
        else:
            interface_type = 'ethernet'
        interface = {
            'id': str(index), 'alias': str(row.get('alias') or '网络接口 {}'.format(index)),
            'ip': str(address), 'prefixLength': prefix,
            'gateway': str(gateway) if gateway is not None else None,
            'mac': _normalize_mac(row.get('mac')), 'type': interface_type,
            'cidr': str(subnet), 'scanCidr': str(active_subnet),
            'scopeLimited': prefix < 24,
        }
        # A public interface ID corresponds to one source IPv4 address. Prefer
        # its usable default route and primary address when aliases coexist.
        priority = (not _is_subnet_host(gateway, subnet),
                    bool(row.get('skipAsSource')), address.is_link_local, int(address))
        candidates.append((index, priority, interface))
    candidates.sort(key=lambda entry: (entry[0], entry[1]))
    selected = {}
    for index, _, interface in candidates:
        selected.setdefault(index, interface)
    return list(selected.values()), {entry[2]['ip'] for entry in candidates}


def _normalize_interfaces(rows):
    return _normalize_interface_inventory(rows)[0]


def _read_interface_inventory():
    # Preserve every connected local IPv4 before selecting one source address
    # per interface, so secondary local aliases cannot become remote devices.
    return _normalize_interface_inventory(_run_powershell(INTERFACE_SCRIPT))


def list_interfaces():
    """Return connected IPv4 interfaces and their bounded discovery scopes."""
    return _read_interface_inventory()[0]


def _read_neighbors():
    return _run_powershell(NEIGHBOR_SCRIPT)


def _scan_scope(interface):
    subnet = ipaddress.IPv4Network(interface['cidr'])
    active_subnet = ipaddress.IPv4Network(interface['scanCidr'])
    if not active_subnet.subnet_of(subnet) or active_subnet.prefixlen < 24:
        raise ValueError('扫描范围不属于所选网络。')
    source = ipaddress.IPv4Address(interface['ip'])
    targets = [str(address) for address in active_subnet.hosts()
               if address != source and _unicast_address(str(address)) is not None]
    return ({'cidr': str(subnet), 'scanCidr': str(active_subnet),
             'targetCount': len(targets), 'limited': interface['scopeLimited']}, targets)


@functools.lru_cache(maxsize=1)
def _load_send_arp():
    # ULONG remains 32 bits on 64-bit Windows. The source IP explicitly selects
    # the chosen interface; zero would let Windows select another interface.
    function = ctypes.WinDLL('iphlpapi.dll').SendARP
    function.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p,
                         ctypes.POINTER(ctypes.c_uint32)]
    function.restype = ctypes.c_uint32
    return function


def _probe_address(source_ip, destination_ip):
    function = _load_send_arp()
    destination = int.from_bytes(socket.inet_aton(destination_ip), 'little')
    source = int.from_bytes(socket.inet_aton(source_ip), 'little')
    buffer = (ctypes.c_uint32 * 2)()
    length = ctypes.c_uint32(ctypes.sizeof(buffer))
    started = time.perf_counter()
    result = function(destination, source, ctypes.byref(buffer), ctypes.byref(length))
    latency = round((time.perf_counter() - started) * 1000, 2)
    if result != 0 or length.value != 6:
        return None
    mac = _normalize_mac(ctypes.string_at(buffer, 6).hex())
    if mac is None:
        return None
    return {'ip': destination_ip, 'mac': mac, 'latencyMs': latency}


def _assemble_devices(interface, neighbors, responses, local_ips):
    subnet = ipaddress.IPv4Network(interface['cidr'])
    self_ip = interface['ip']
    local_ips = set(local_ips) | {self_ip}
    devices = {self_ip: {
        'id': self_ip, 'ip': self_ip, 'mac': interface['mac'],
        'hostname': socket.gethostname(), 'kind': 'self', 'status': 'online',
        'evidence': ['本机已连接的 IPv4 网络接口'], 'latencyMs': None,
    }}
    gateway = _unicast_address(interface.get('gateway'))
    gateway_ip = str(gateway) if _is_subnet_host(gateway, subnet) else None
    if gateway_ip is not None and gateway_ip not in local_ips:
        devices[gateway_ip] = {
            'id': gateway_ip, 'ip': gateway_ip, 'mac': None, 'hostname': None,
            'kind': 'gateway', 'status': 'unverified',
            'evidence': ['所选接口配置的默认网关，尚未验证响应'], 'latencyMs': None,
        }
    for row in neighbors:
        if str(row.get('id')) != interface['id']:
            continue
        address = _unicast_address(row.get('ip'))
        mac = _normalize_mac(row.get('mac'))
        if not _is_subnet_host(address, subnet) or mac is None:
            continue
        ip = str(address)
        if ip in local_ips:
            continue
        device = devices.setdefault(ip, {
            'id': ip, 'ip': ip, 'mac': None, 'hostname': None,
            'kind': 'gateway' if ip == gateway_ip else 'device',
            'status': 'cached', 'evidence': [], 'latencyMs': None,
        })
        device['mac'] = mac
        device['status'] = 'cached'
        evidence = '所选接口的 Windows 邻居缓存记录，不代表当前在线'
        if evidence not in device['evidence']:
            device['evidence'].append(evidence)
    for response in responses:
        address = _unicast_address(response.get('ip'))
        mac = _normalize_mac(response.get('mac'))
        if not _is_subnet_host(address, subnet) or mac is None:
            continue
        ip = str(address)
        if ip in local_ips:
            continue
        device = devices.setdefault(ip, {
            'id': ip, 'ip': ip, 'mac': None, 'hostname': None,
            'kind': 'gateway' if ip == gateway_ip else 'device',
            'status': 'resolved', 'evidence': [], 'latencyMs': None,
        })
        device.update(mac=mac, status='resolved', latencyMs=response.get('latencyMs'))
        device['evidence'].append('本次地址解析成功（可能来自系统缓存，不保证当前在线）')
    return sorted(devices.values(), key=lambda device: (device['kind'] != 'self',
                                                         int(ipaddress.IPv4Address(device['ip']))))


def scan_network(interface_id, progress_callback=None):
    """Discover real peers on one currently connected IPv4 interface.

    Native ARP resolution uses up to 64 concurrent calls and at most a /24.
    Windows controls each SendARP call's timeout. Successful resolution may use
    the system cache, so peers are resolved rather than confirmed online.
    Cache-only entries retain their weaker cached status.
    """
    started = time.perf_counter()
    interfaces, local_ips = _read_interface_inventory()
    if not isinstance(interface_id, str) or not interface_id.isdecimal():
        raise ValueError('请选择有效的已连接网络接口。')
    interface = next((item for item in interfaces if item['id'] == interface_id), None)
    if interface is None:
        raise ValueError('所选网络接口已断开或不存在，请刷新网络列表。')
    scope, targets = _scan_scope(interface)
    total = len(targets)
    warnings = []
    if scope['limited']:
        warnings.append('所选网络大于 /24；主动探测仅覆盖本机所在的 {}，'
                        '同一实际子网内的其他地址仅显示已有邻居缓存。'.format(scope['scanCidr']))
    def emit(phase, completed, message):
        if progress_callback is not None:
            progress_callback({'phase': phase, 'completed': completed,
                               'total': total, 'message': message})
    emit('discovering', 0, '正在读取所选网络的邻居缓存')
    neighbors = []
    cache_warning = '无法读取 Windows 邻居缓存；结果仅包含本机、配置网关和本次成功解析的设备。'
    try:
        neighbors.extend(_read_neighbors())
    except (NetworkCollectionError, OSError):
        warnings.append(cache_warning)
    responses = []
    probe_error = False
    emit('probing', 0, '正在解析同一子网内的设备地址')
    if targets:
        with ThreadPoolExecutor(max_workers=min(MAX_PROBE_WORKERS, total)) as pool:
            futures = [pool.submit(_probe_address, interface['ip'], target) for target in targets]
            try:
                for completed, future in enumerate(as_completed(futures), 1):
                    try:
                        response = future.result()
                        if response is not None:
                            responses.append(response)
                    except (OSError, RuntimeError, AttributeError):
                        probe_error = True
                    emit('probing', completed, '已完成 {} / {} 个地址'.format(completed, total))
            finally:
                # A progress callback can raise CancelledError when the window
                # closes. Discard queued work before waiting for native calls
                # already running, which Windows does not allow us to abort.
                for future in futures:
                    future.cancel()
    if probe_error:
        warnings.append('部分地址未能执行 Windows ARP 解析；设备发现结果可能不完整。')
    try:
        neighbors.extend(_read_neighbors())
    except (NetworkCollectionError, OSError):
        if cache_warning not in warnings:
            warnings.append(cache_warning)
    devices = _assemble_devices(interface, neighbors, responses, local_ips)
    ids = {device['id'] for device in devices}
    gateway = interface.get('gateway')
    anchor = gateway if gateway in ids else interface['ip']
    links = [{'source': anchor, 'target': device['id'],
              'kind': 'same-subnet', 'inferred': True}
             for device in devices if device['id'] != anchor]
    emit('finishing', total, '设备发现完成，正在整理同一子网关系')
    return {
        'interface': interface, 'devices': devices, 'links': links,
        'scannedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
        'durationMs': round((time.perf_counter() - started) * 1000),
        'warnings': warnings, 'scope': scope,
    }
