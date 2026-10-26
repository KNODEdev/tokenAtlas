"""Collect exact local JS and locked Cargo dependency license texts without building."""

import argparse
import concurrent.futures
import hashlib
import io
import json
import pathlib
import re
import tarfile
import tomllib
import urllib.request


def notice_name(name):
    return bool(re.match(r'(?:licen[cs]e|unlicense|copying|notice|copyright|ofl|ufl)(?:[._-]|$)', name, re.I))


def javascript(root, cache, dependency_root=None):
    directory = (dependency_root or root) / 'node_modules'
    manifests = sorted([*directory.glob('*/package.json'), *directory.glob('@*/*/package.json')])
    if not manifests:
        raise RuntimeError('Install the locked JavaScript dependencies first.')
    lock = (root / 'bun.lock').read_text(encoding='utf-8')
    records = []
    for manifest in manifests:
        package = json.loads(manifest.read_text(encoding='utf-8'))
        name, version = package['name'], package['version']
        if f'"{name}@{version}"' not in lock:
            raise RuntimeError(f'Installed package not in bun.lock: {name}@{version}')
        texts = []
        for path in sorted(manifest.parent.iterdir()):
            if path.is_file() and notice_name(path.name):
                texts.append((path.name, path.read_text(encoding='utf-8', errors='replace')))
        license_id = package.get('license')
        if not texts:
            notice_cache = cache / ('npm-' + name.replace('/', '_') + '-' + version + '.json')
            if notice_cache.is_file():
                upstream = json.loads(notice_cache.read_text(encoding='utf-8'))
            else:
                url = f'https://registry.npmjs.org/{name}/{version}'
                with urllib.request.urlopen(url, timeout=45) as response:
                    metadata = json.load(response)
                repository = metadata.get('repository', {})
                repository = repository.get('url', '') if isinstance(repository, dict) else repository
                match = re.search(r'github\.com[/:]([^/]+)/([^/#]+?)(?:\.git)?$', repository)
                revision = metadata.get('gitHead', '')
                if not match:
                    raise RuntimeError(f'No upstream notice source for {name}@{version}')
                owner, repo = match.groups()
                if not re.fullmatch('[a-f0-9]{40}', revision):
                    request = urllib.request.Request(f'https://api.github.com/repos/{owner}/{repo}/commits/HEAD', headers={'User-Agent': 'tokenAtlas-license-inventory'})
                    with urllib.request.urlopen(request, timeout=30) as response:
                        revision = json.load(response)['sha']
                    provenance = 'Current upstream notice supplement; the versioned npm metadata determines the declared license.'
                else:
                    provenance = 'Notice at the gitHead recorded in the versioned npm metadata.'
                upstream = {'revision': revision, 'provenance': provenance, 'texts': []}
                for notice in ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'LICENSE-MIT', 'LICENSE-APACHE', 'NOTICE', 'drizzle-kit/LICENSE', 'drizzle-orm/LICENSE']:
                    source = f'https://raw.githubusercontent.com/{owner}/{repo}/{revision}/{notice}'
                    try:
                        with urllib.request.urlopen(source, timeout=25) as response:
                            text = response.read().decode('utf-8')
                        upstream['texts'].append((source, text))
                    except urllib.error.HTTPError as error:
                        if error.code != 404:
                            raise
                notice_cache.write_text(json.dumps(upstream), encoding='utf-8')
            texts = [(source, upstream.get('provenance', '') + '\n\n' + text) for source, text in upstream['texts']]
        if not isinstance(license_id, str) or not texts:
            raise RuntimeError(f'Missing JS license metadata or text: {name}@{version}')
        records.append({'ecosystem': 'npm', 'name': name, 'version': version,
                        'license': license_id, 'source': f'https://www.npmjs.com/package/{name}/v/{version}',
                        'texts': texts})
    return records


def rust_package(package, cache, cargo_cache):
    name, version = package['name'], package['version']
    filename = f'{name}-{version}.crate'
    candidates = [*cargo_cache.glob('*/' + filename), cache / filename]
    data = next((p.read_bytes() for p in candidates if p.is_file()), None)
    if data is None:
        url = f'https://static.crates.io/crates/{name}/{filename}'
        with urllib.request.urlopen(url, timeout=90) as response:
            data = response.read()
        (cache / filename).write_bytes(data)
    if hashlib.sha256(data).hexdigest() != package['checksum']:
        raise RuntimeError(f'Cargo.lock checksum mismatch: {filename}')
    texts = []
    manifest = None
    vcs = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        members = archive.getmembers()
        for member in members:
            if not member.isfile():
                continue
            path = pathlib.PurePosixPath(member.name)
            relative = pathlib.PurePosixPath(*path.parts[1:])
            if str(relative) == 'Cargo.toml':
                manifest = tomllib.loads(archive.extractfile(member).read().decode('utf-8'))['package']
            if str(relative) == '.cargo_vcs_info.json':
                vcs = json.loads(archive.extractfile(member).read())
            if notice_name(path.name) or any(re.fullmatch(r'licen[cs]es?', part, re.I) for part in relative.parts[:-1]):
                if member.size > 2 * 1024 * 1024:
                    raise RuntimeError(f'Oversized license text: {filename}:{relative}')
                texts.append((str(relative), archive.extractfile(member).read().decode('utf-8', errors='replace')))
        if manifest and manifest.get('license-file'):
            relative = manifest['license-file']
            if relative not in {p for p, _ in texts}:
                member = next((m for m in members if m.name == f'{name}-{version}/{relative}'), None)
                if member:
                    texts.append((relative, archive.extractfile(member).read().decode('utf-8', errors='replace')))
    license_id = (manifest or {}).get('license') or (manifest or {}).get('license-file')
    if not texts:
        match = re.search(r'github\.com[/:]([^/]+)/([^/#]+)', (manifest or {}).get('repository', ''))
        revision = vcs.get('git', {}).get('sha1', '')
        supplement = cache / ('cargo-' + name + '-' + version + '.json')
        if supplement.is_file():
            texts = json.loads(supplement.read_text(encoding='utf-8'))
        if not texts and match:
            owner, repo = match.groups()
            repo = repo.removesuffix('.git')
            if not re.fullmatch('[a-f0-9]{40}', revision):
                request = urllib.request.Request(f'https://api.github.com/repos/{owner}/{repo}/commits/HEAD', headers={'User-Agent': 'tokenAtlas-license-inventory'})
                with urllib.request.urlopen(request, timeout=30) as response:
                    revision = json.load(response)['sha']
            subdir = vcs.get('path_in_vcs', '')
            tree_cache = cache / (owner + '-' + repo + '-' + revision + '-tree.json')
            if tree_cache.is_file():
                tree = json.loads(tree_cache.read_text(encoding='utf-8'))
            else:
                request = urllib.request.Request(f'https://api.github.com/repos/{owner}/{repo}/git/trees/{revision}?recursive=1', headers={'User-Agent': 'tokenAtlas-license-inventory'})
                with urllib.request.urlopen(request, timeout=45) as response:
                    tree = json.load(response)
                tree_cache.write_text(json.dumps(tree), encoding='utf-8')
            paths = [entry['path'] for entry in tree.get('tree', []) if entry['type'] == 'blob'
                     and notice_name(pathlib.PurePosixPath(entry['path']).name)
                     and (len(pathlib.PurePosixPath(entry['path']).parts) == 1 or entry['path'].startswith(subdir + '/') and subdir)]
            for notice in paths:
                source = f'https://raw.githubusercontent.com/{owner}/{repo}/{revision}/{notice.lstrip("/")}'
                try:
                    with urllib.request.urlopen(source, timeout=25) as response:
                        texts.append((source, response.read().decode('utf-8')))
                except urllib.error.HTTPError as error:
                    if error.code != 404:
                        raise
            supplement.write_text(json.dumps(texts), encoding='utf-8')
    if not license_id:
        raise RuntimeError(f'Missing Cargo license metadata: {filename}')
    return {'ecosystem': 'cargo', 'name': name, 'version': version, 'license': license_id,
            'checksum': package['checksum'], 'source': f'https://crates.io/crates/{name}/{version}',
            'notice_status': 'included' if texts else 'MISSING: review upstream before distributing binaries', 'texts': texts}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[2])
    parser.add_argument('--cache', type=pathlib.Path)
    parser.add_argument('--javascript-root', type=pathlib.Path, help='Use dependencies installed in an isolated copy with the same Bun lockfile.')
    args = parser.parse_args()
    root = args.root.resolve()
    cache = (args.cache or root / 'TMP' / 'release-license-cache').resolve()
    cache.mkdir(parents=True, exist_ok=True)
    locks = sorted(root.glob('native/*/Cargo.lock'))
    packages = {}
    for lock in locks:
        for package in tomllib.loads(lock.read_text(encoding='utf-8'))['package']:
            if package.get('source', '').startswith('registry+'):
                if package['source'] != 'registry+https://github.com/rust-lang/crates.io-index':
                    raise RuntimeError('An unrecognised registry needs manual review.')
                packages[(package['name'], package['version'])] = package
            elif package.get('source'):
                raise RuntimeError('A non-registry Cargo dependency needs manual review.')
    if args.javascript_root and (args.javascript_root / 'bun.lock').read_bytes() != (root / 'bun.lock').read_bytes():
        raise RuntimeError('The isolated dependency tree uses a different lockfile.')
    records = javascript(root, cache, args.javascript_root)
    cargo_cache = pathlib.Path.home() / '.cargo' / 'registry' / 'cache'
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        records.extend(pool.map(lambda p: rust_package(p, cache, cargo_cache), packages.values()))
    records.sort(key=lambda p: (p['ecosystem'], p['name'], p['version']))
    output = root / 'licenses'
    output.mkdir(exist_ok=True)
    inputs = [root / 'bun.lock', *locks]
    inventory = {
        'scope': 'Installed JavaScript dependency tree (verify Bun lock first), and all registry packages in every native Cargo.lock, including target-specific and build/test dependencies.',
        'limits': 'This is a notice inventory, not a vulnerability scan, legal opinion or proof of authorship. Review SPDX alternatives and any copyleft obligations before distributing binaries.',
        'lock_sha256': {str(p.relative_to(root)).replace('\\', '/'): hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs},
        'packages': [{k: v for k, v in p.items() if k != 'texts'} | {'notice_files': [name for name, _ in p['texts']]} for p in records],
    }
    (output / 'dependencies.json').write_text(json.dumps(inventory, indent=2) + '\n', encoding='utf-8')
    sections = ['Third-party dependency notices\n\nGenerated by scripts/release/collect-licenses.py.\nSee dependencies.json for exact scope and lockfile hashes.\n']
    for record in records:
        sections.append(f"\n{'=' * 72}\n{record['ecosystem']}: {record['name']} {record['version']}\nDeclared license: {record['license']}\nSource: {record['source']}\n")
        for name, text in record['texts']:
            sections.append(f'\n--- {name} ---\n{text.rstrip()}\n')
    notice_text = re.sub(r'\r+\n', '\n', ''.join(sections)).replace('\r', '\n')
    notice_text = '\n'.join(line.rstrip() for line in notice_text.splitlines()) + '\n'
    (output / 'third-party.txt').write_text(notice_text, encoding='utf-8', newline='\n')
    print(json.dumps({'packages': len(records), 'cargo': len(packages), 'output': str(output.relative_to(root)), 'missing_notices': [p['name'] for p in records if not p['texts']],
                      'license_expressions': sorted({p['license'] for p in records})}))
    if any(not package['texts'] for package in records):
        raise SystemExit(2)


if __name__ == '__main__':
    main()
