"""Fetch pinned Three.js assets from the official npm registry."""
import base64
import hashlib
import io
from pathlib import Path
import tarfile
import urllib.request

VERSION = '0.187.0'
INTEGRITY = 'Qiu7R+Cmh8CstZsY1uJOSWnVlfo7ZtNLV7mF8Jltk3LB3AtDu9cRZlcnRKkAk8Y4z6KKw35z7Y7Urd7jWY8etA=='
DESTINATION = Path(__file__).resolve().parent.parent / 'web' / 'vendor'
FILES = {'package/build/three.module.js': 'three.module.js',
         'package/build/three.core.js': 'three.core.js',
         'package/examples/jsm/controls/OrbitControls.js': 'OrbitControls.js',
         'package/LICENSE': 'THREE-LICENSE.txt'}


def main():
    url = 'https://registry.npmjs.org/three/-/three-{}.tgz'.format(VERSION)
    with urllib.request.urlopen(url, timeout=60) as response:
        payload = response.read()
    actual = base64.b64encode(hashlib.sha512(payload).digest()).decode('ascii')
    if actual != INTEGRITY:
        raise RuntimeError('Three.js package checksum does not match')
    DESTINATION.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as archive:
        for source, name in FILES.items():
            data = archive.extractfile(source).read()
            (DESTINATION / name).write_bytes(data)
            print('{}: {} bytes'.format(name, len(data)))
    print('Vendored Three.js ' + VERSION)


if __name__ == '__main__':
    main()
