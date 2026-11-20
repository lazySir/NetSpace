"""Exercise a built Windows executable with no Python installation on PATH."""
import argparse
from collections import Counter
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import time
import urllib.request
from zipfile import ZipFile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--exe', default='dist/NetSpace.exe')
    parser.add_argument('--port', type=int, default=8766)
    parser.add_argument('--no-network', action='store_true',
                        help='Check startup, assets and shutdown only; never enumerate or probe the LAN')
    args = parser.parse_args()
    distribution = Path(args.exe).resolve().parent / 'NetSpace-Windows-x64.zip'
    with ZipFile(str(distribution)) as archive:
        archive_names = set(archive.namelist())
        assert 'FUSE-LICENSE.txt' in archive_names, 'Windows distribution must include the vendored Fuse.js license'
        assert 'THIRD_PARTY_NOTICES.md' in archive_names, 'Windows distribution must include third-party notices'
    executable = str(Path(args.exe).resolve())
    base = 'http://127.0.0.1:{}'.format(args.port)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(path, data=None, timeout=30):
        if args.no_network and path.startswith('/api/'):
            assert path in {'/api/health', '/api/state', '/api/history', '/api/device-check',
                            '/api/web-header-check', '/api/shutdown'}
            assert data is None or path == '/api/shutdown', 'No network tasks may start in no-network mode'
        payload = None if data is None else json.dumps(data).encode('utf-8')
        req = urllib.request.Request(base + path, data=payload,
                                     headers={'Content-Type': 'application/json'})
        with opener.open(req, timeout=timeout) as response:
            body = response.read()
            if 'application/json' in response.headers.get('Content-Type', ''):
                return json.loads(body.decode('utf-8'))
            return body

    def response_headers(path):
        req = urllib.request.Request(base + path)
        with opener.open(req, timeout=3) as response:
            return response.headers

    def request_with_headers(path, timeout=30):
        req = urllib.request.Request(base + path)
        with opener.open(req, timeout=timeout) as response:
            return response.read(), response.headers

    try:
        request('/api/health', timeout=1)
    except Exception:
        pass
    else:
        raise RuntimeError('Verification port is already occupied')
    environment = os.environ.copy()
    system_root = environment.get('SystemRoot', r'C:\Windows')
    environment['PATH'] = os.path.join(system_root, 'System32')
    data_folder = tempfile.TemporaryDirectory(prefix='netspace-package-')

    def launch():
        return subprocess.Popen([executable, '--no-browser', '--port', str(args.port),
                                 '--data-dir', data_folder.name], env=environment,
                                creationflags=subprocess.CREATE_NO_WINDOW)

    process = launch()
    checks = []

    def wait_start():
        deadline = time.monotonic() + 25
        while True:
            if process.poll() is not None:
                raise RuntimeError('Packaged application exited before startup')
            try:
                health = request('/api/health', timeout=1)
                assert health == {'app': 'NetSpace', 'version': '1.17.0'}
                break
            except Exception:
                if time.monotonic() > deadline:
                    raise
                time.sleep(.25)

    def wait_result():
        deadline = time.monotonic() + 150
        while True:
            state = request('/api/state')
            if state['status'] != 'scanning':
                break
            assert time.monotonic() < deadline, 'Discovery did not finish within the integration timeout'
            time.sleep(.5)
        assert state['status'] == 'complete', state.get('error')
        return state['result']

    try:
        wait_start()
        checks.append('bundled runtime without Python on PATH')
        for resource in ('/', '/app.js', '/device-check.js', '/device-check-report.js', '/web-header-check.js', '/data-cleanup.js', '/workspace.js', '/csv.js', '/identity.js', '/scene.js', '/style.css',
                         '/vendor/three.module.js', '/vendor/three.core.js', '/vendor/OrbitControls.js', '/vendor/fuse.min.js'):
            bundled = request(resource)
            assert len(bundled) > 100, resource
            policy = response_headers(resource).get('Content-Security-Policy', '')
            assert "default-src 'self'" in policy, resource + ' must have CSP'
            assert "object-src 'none'" in policy, resource + ' must block object content'
            source_path = Path('web') / (resource.lstrip('/') or 'index.html')
            assert bundled == source_path.read_bytes(), 'Packaged resource differs from source: ' + resource
        checks.append('all bundled page and 3D resources')
        duplicate = launch()
        assert duplicate.wait(timeout=15) == 0
        assert process.poll() is None
        assert request('/api/health')['app'] == 'NetSpace'
        checks.append('duplicate launch keeps one application')
        if args.no_network:
            state = request('/api/state')
            assert state['status'] == 'idle' and state['result'] is None
            assert state['deviceCheck']['status'] == 'idle'
            assert not state['monitor']['enabled']
            assert request('/api/history')['scans'] == []
            assert request('/api/device-check')['status'] == 'idle'
            assert request('/api/web-header-check')['status'] == 'idle'
            checks.append('discovery, monitor and device check remain idle')
            request('/api/shutdown', {})
            assert process.wait(timeout=15) == 0
            checks.append('clean application shutdown')
            print(json.dumps({'result': 'PASS', 'mode': 'no-network', 'checks': checks}))
            return
        interfaces = request('/api/interfaces')['interfaces']
        assert interfaces, 'A connected Windows IPv4 interface is required for this integration check'
        request('/api/scan', {'interfaceId': str(interfaces[0]['id'])})
        result = wait_result()
        assert result['interface']['id'] == str(interfaces[0]['id'])
        assert any(device['kind'] == 'self' for device in result['devices'])
        assert all(device['status'] != 'online' for device in result['devices'] if device['kind'] != 'self')
        device_ids = {device['id'] for device in result['devices']}
        assert all(link['inferred'] and link['source'] in device_ids and link['target'] in device_ids
                   for link in result['links'])
        artifact = Path('artifacts/packaged-result.json')
        artifact.parent.mkdir(exist_ok=True)
        artifact.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        checks.append('native discovery and factual device status')
        checks.append('inferred 3D graph data')
        first_scan_id = result['scanId']
        network_id = result['networkId']
        own_device = next(device for device in result['devices'] if device['kind'] == 'self')
        identity = {'networkId': network_id, 'deviceKey': own_device['deviceKey']}
        request('/api/profile', dict(identity, alias='打包验证电脑', notes='重启后仍需保留', group='验证', known=True))
        request('/api/monitor', {'notificationsEnabled': False})
        assert request('/api/events')['unreadCount'] == 0, 'First baseline must be quiet'
        assert request('/api/history/' + str(first_scan_id))['result']['devices'] == result['devices']
        request('/api/shutdown', {})
        assert process.wait(timeout=15) == 0
        assert (Path(data_folder.name) / 'netspace.db').is_file()
        process = launch()
        wait_start()
        monitor = request('/api/monitor')
        assert not monitor['enabled'] and not monitor['notificationsEnabled']
        devices = request('/api/devices?networkId=' + network_id)['devices']
        saved_device = next(device for device in devices if device['deviceKey'] == own_device['deviceKey'])
        assert saved_device['profile']['alias'] == '打包验证电脑'
        assert saved_device['profile']['known'] is True
        assert request('/api/history')['scans'][0]['id'] == first_scan_id
        backup_bytes, backup_headers = request_with_headers('/api/backup')
        assert backup_headers.get('Content-Type') == 'application/vnd.sqlite3'
        assert backup_headers.get('Content-Disposition', '').startswith('attachment; filename="NetSpace-backup-')
        backup_path = Path(data_folder.name) / 'downloaded-backup.db'
        backup_path.write_bytes(backup_bytes)
        downloaded_backup = sqlite3.connect(str(backup_path))
        try:
            assert downloaded_backup.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
            assert downloaded_backup.execute('SELECT COUNT(*) FROM scans').fetchone()[0] == 1
            assert '打包验证电脑' in downloaded_backup.execute(
                'SELECT profile FROM devices WHERE device_key = ?', (own_device['deviceKey'],)).fetchone()[0]
        finally:
            downloaded_backup.close()
        checks.append('local SQLite backup download and integrity')
        checks.append('profiles, settings and immutable history persist across executable restart')
        enabled = request('/api/monitor', {'enabled': True, 'interfaceId': str(interfaces[0]['id']),
                                           'intervalSeconds': 60})
        assert enabled['enabled'] and enabled['nextScanAt']
        deadline = time.monotonic() + 5
        while request('/api/state')['status'] == 'idle':
            assert time.monotonic() < deadline, 'Monitor did not trigger immediate discovery'
            time.sleep(.1)
        request('/api/monitor', {'enabled': False})
        second = wait_result()
        assert second['scanId'] > first_scan_id
        second_self = next(device for device in second['devices'] if device['kind'] == 'self')
        assert second_self['profile']['alias'] == '打包验证电脑'
        assert len(request('/api/history?networkId=' + network_id)['scans']) == 2
        assert not request('/api/monitor')['enabled']
        checks.append('scheduled native discovery, disable while running, and preserved profile identity')
        request('/api/shutdown', {})
        assert process.wait(timeout=15) == 0
        checks.append('clean application shutdown')
        print(json.dumps({'result': 'PASS', 'checks': checks,
                          'devices': len(result['devices']), 'links': len(result['links']),
                          'statuses': dict(Counter(device['status'] for device in result['devices'])),
                          'durationMs': result['durationMs'], 'warnings': result['warnings']}, ensure_ascii=False))
    finally:
        if process.poll() is None:
            try:
                request('/api/shutdown', {}, timeout=3)
                process.wait(timeout=15)
            except Exception:
                process.terminate()
                process.wait(timeout=10)
        data_folder.cleanup()


if __name__ == '__main__':
    main()
