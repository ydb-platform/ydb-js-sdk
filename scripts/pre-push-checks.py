#!/usr/bin/env python3
"""Run the existing pre-push build and all unit tests with bounded, sequential jobs."""

import argparse
from collections import defaultdict
import json
from pathlib import Path
import subprocess
import sys
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--list', action='store_true', help='Only discover and list the test groups.')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    logs = Path(tempfile.mkdtemp(prefix='ydb-pre-push-'))
    print(f'Bounded pre-push logs: {logs}', flush=True)

    def run(name, command, timeout=120):
        subprocess.run([
            sys.executable, str(root / 'scripts/run-bounded.py'),
            '--timeout', str(timeout), '--memory-mib', '512',
            '--log', str(logs / f'{name}.log'), '--', *command,
        ], cwd=root, check=True)

    vitest = ['node', '--max-old-space-size=128', 'node_modules/vitest/vitest.mjs']
    inventory = logs / 'tests.json'
    run('inventory', [*vitest, 'list', '--project', 'uni', '--filesOnly', f'--json={inventory}'])
    groups = defaultdict(list)
    for entry in json.loads(inventory.read_text()):
        path = Path(entry['file']).resolve().relative_to(root)
        if entry['projectName'] != 'uni':
            raise RuntimeError(f'Unexpected test project: {entry["projectName"]}')
        key = '/'.join(path.parts[:2]) if path.parts[0] in ('packages', 'third-parties') else str(path.parent)
        groups[key].append(str(path))
    if not groups:
        raise RuntimeError('Unit test discovery returned no files.')
    print(json.dumps({key: len(files) for key, files in sorted(groups.items())}), flush=True)
    if args.list:
        return

    run('build', ['npm', 'run', 'build', '--', '--filter=...[origin/main]', '--concurrency=1'], timeout=300)
    for key, files in sorted(groups.items()):
        for offset in range(0, len(files), 8):
            run(f'{key.replace("/", "-")}-{offset // 8 + 1}', [
                *vitest, 'run', '--project', 'uni', *files[offset:offset + 8],
                '--maxWorkers=1', '--no-file-parallelism', '--no-passWithNoTests',
            ])


if __name__ == '__main__':
    main()
