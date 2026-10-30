#!/usr/bin/env python3
"""Run one verification job with an external process-group memory/time watchdog."""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
import uuid


def processes():
    output = subprocess.check_output(
        ['/bin/ps', '-axo', 'pid=,ppid=,pgid=,rss='], text=True, timeout=3
    )
    return [tuple(map(int, line.split())) for line in output.splitlines() if line.strip()]


def available_memory():
    if sys.platform != 'darwin':
        return None
    output = subprocess.check_output(['/usr/bin/vm_stat'], text=True, timeout=3)
    size = int(re.search(r'page size of (\d+) bytes', output).group(1))
    pages = sum(
        int(re.search(rf'{name}:\s+(\d+)', output).group(1))
        for name in ['Pages free', 'Pages speculative', 'Pages inactive']
    )
    return pages * size


def group_rows(rows, group):
    return [row for row in rows if row[2] == group]


def stop_group(group):
    for sig in [signal.SIGTERM, signal.SIGKILL]:
        members = group_rows(processes(), group)
        if not members:
            return
        # Some managed hosts permit signalling owned PIDs but reject killpg().
        for pid, _parent, _group, _rss in reversed(members):
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            try:
                if not group_rows(processes(), group):
                    return
            except (subprocess.SubprocessError, OSError):
                break
            time.sleep(0.05)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--memory-mib', type=int, default=512)
    parser.add_argument('--reserve-mib', type=int, default=2048)
    parser.add_argument('--timeout', type=float, default=120)
    parser.add_argument('--log', required=True)
    parser.add_argument('--log-mib', type=int, default=8)
    parser.add_argument('--docker', action='store_true', help='Clean up only containers labelled by this verification run.')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command or min(args.memory_mib, args.reserve_mib, args.timeout, args.log_mib) <= 0:
        parser.error('A command and positive limits are required.')

    # flock protects against concurrent runs even after an earlier supervisor was interrupted.
    root = Path(__file__).resolve().parent.parent
    key = hashlib.sha256(str(root).encode()).hexdigest()[:16]
    lock_path = Path(tempfile.gettempdir()) / f'ydb-query-verification-{key}.lock'
    with lock_path.open('a+') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Another bounded verification job is still running.', file=sys.stderr)
            return 75

        # Fail closed if process inspection is unavailable; a JS timer cannot stop a native hang.
        rows = processes()
        lock.seek(0)
        previous = lock.read().strip()
        if previous and group_rows(rows, int(previous)):
            print('An earlier verification process group is still running.', file=sys.stderr)
            return 75
        available = available_memory()
        if available is not None and available < (args.reserve_mib + args.memory_mib) * 1024**2:
            print('Not enough available host memory for this verification job.', file=sys.stderr)
            return 75

        log_path = Path(args.log).resolve()
        log_path.parent.mkdir(parents=True, exist_ok=True)
        env = os.environ.copy()
        env['NODE_OPTIONS'] = (env.get('NODE_OPTIONS', '') + ' --max-old-space-size=192').strip()
        env['YDB_TEST_DOCKER_MEMORY'] = '2g'
        env['YDB_TEST_DOCKER_CPUS'] = '1'
        docker_run = str(uuid.uuid4()) if args.docker else None
        if docker_run:
            subprocess.run(['docker', 'info', '--format', '{{.ServerVersion}}'], check=True, stdout=subprocess.DEVNULL, timeout=10)
            env['YDB_TEST_RUN_ID'] = docker_run
        child = None
        interrupted = False

        def interrupt(_signum, _frame):
            nonlocal interrupted
            interrupted = True

        for sig in [signal.SIGINT, signal.SIGTERM]:
            signal.signal(sig, interrupt)

        started = time.monotonic()
        peak = 0
        reason = 'completed'
        exit_code = 1
        with log_path.open('wb') as log:
            try:
                child = subprocess.Popen(
                    command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT,
                    stdin=subprocess.DEVNULL, start_new_session=True,
                )
                lock.seek(0)
                lock.truncate()
                lock.write(str(child.pid))
                lock.flush()
                while True:
                    rows = group_rows(processes(), child.pid)
                    rss = sum(row[3] for row in rows) * 1024
                    peak = max(peak, rss)
                    available = available_memory()
                    if interrupted:
                        reason = 'interrupted'
                    elif rss > args.memory_mib * 1024**2:
                        reason = 'memory_limit'
                    elif available is not None and available < args.reserve_mib * 1024**2:
                        reason = 'host_memory_reserve'
                    elif time.monotonic() - started > args.timeout:
                        reason = 'timeout'
                    elif log_path.stat().st_size > args.log_mib * 1024**2:
                        reason = 'log_limit'
                    elif child.poll() is not None:
                        exit_code = child.returncode
                        break
                    if reason != 'completed':
                        exit_code = 124
                        break
                    time.sleep(0.2)
            finally:
                try:
                    if child is not None:
                        stop_group(child.pid)
                        child.wait(timeout=5)
                        if not group_rows(processes(), child.pid):
                            lock.seek(0)
                            lock.truncate()
                finally:
                    if docker_run:
                        containers = subprocess.check_output(
                            ['docker', 'ps', '-aq', '--filter', f'label=ydbjs.verification={docker_run}'],
                            text=True, timeout=10,
                        ).split()
                        if containers:
                            subprocess.run(['docker', 'rm', '-f', *containers], check=True, stdout=subprocess.DEVNULL, timeout=15)

        report = {
            'reason': reason, 'exitCode': exit_code,
            'elapsedSeconds': round(time.monotonic() - started, 2),
            'sampledPeakGroupRssMiB': round(peak / 1024**2, 1),
            'memoryLimitMiB': args.memory_mib, 'log': str(log_path),
        }
        Path(str(log_path) + '.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report))
        with log_path.open('rb') as log:
            log.seek(max(0, log_path.stat().st_size - 2048))
            tail = log.read().decode(errors='replace')
        print(tail, end='' if tail.endswith('\n') else '\n')
        return exit_code if exit_code >= 0 else 128 - exit_code


if __name__ == '__main__':
    sys.exit(main())
