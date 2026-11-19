"""Package reproducible source without local observations or build caches."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED


def main():
    root = Path(__file__).resolve().parent.parent
    destination = root / 'dist' / 'NetSpace-Source.zip'
    destination.parent.mkdir(exist_ok=True)
    sources = [path for path in root.iterdir() if path.is_file()
               and path.suffix in ('.py', '.md', '.bat', '.ps1', '.spec')]
    for directory in ('web', 'assets', 'tests', 'tools', 'docs'):
        sources.extend(path for path in (root / directory).rglob('*')
                       if path.is_file() and '__pycache__' not in path.parts
                       and path.suffix not in ('.pyc', '.db', '.log'))
    with ZipFile(str(destination), 'w', compression=ZIP_DEFLATED) as archive:
        for path in sorted(sources):
            archive.write(str(path), path.relative_to(root).as_posix())
    print('Created dist/NetSpace-Source.zip')


if __name__ == '__main__':
    main()
