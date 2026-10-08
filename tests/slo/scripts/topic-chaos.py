#!/usr/bin/env python3
import argparse
import datetime as dt
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

SCHEDULE = [(60, 'kill', 'database-1', 0), (180, 'pause', 'database-2', 20),
            (300, 'drop', 'database-2', 30), (450, 'kill', 'database-2', 0),
            (600, 'pause', 'database-1', 25), (720, 'drop', 'database-2', 30)]
PROBE = """let net=require('node:net');let done=false;let s=net.createConnection({host:process.argv[1],port:2136});let finish=(code,reason)=>{if(done)return;done=true;s.destroy();console.log(JSON.stringify({code,reason}));process.exit(code)};s.setTimeout(2000,()=>finish(2,'timeout'));s.once('connect',()=>finish(0,'connected'));s.once('error',e=>finish(1,e.code||e.message));"""


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def parse_time(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def docker_args(context):
    return ['docker', '--context', context] if context else ['docker']


def compose_args(args):
    return docker_args(args.context) + ['compose', '-p', args.project, '-f', str(Path(args.compose_file).resolve())]


def validate_node(node, service, project, network):
    labels = node['Config'].get('Labels') or {}
    if labels.get('com.docker.compose.project') != project or labels.get('com.docker.compose.service') != service:
        raise RuntimeError(f'Target identity mismatch: {service}')
    address = node['NetworkSettings']['Networks'].get(network, {}).get('IPAddress')
    if not address:
        raise RuntimeError(f'{service} is outside the requested network')
    ipaddress.ip_address(address)
    return address


def environment(node):
    return dict(entry.split('=', 1) for entry in node['Config'].get('Env', []) if '=' in entry)


def snapshot(node):
    env = environment(node)
    networks = {name: {key: value for key, value in info.items()
                       if key in ['IPAddress', 'Gateway', 'NetworkID', 'Aliases']}
                for name, info in node['NetworkSettings']['Networks'].items()}
    labels = {key: value for key, value in (node['Config'].get('Labels') or {}).items()
              if key.startswith('com.docker.compose.') or key in ['local.task', 'local.upstream-revision']}
    return {'Id': node['Id'], 'Name': node['Name'], 'Image': node['Image'], 'Platform': node.get('Platform'),
            'State': node['State'], 'RestartCount': node['RestartCount'], 'Labels': labels, 'Networks': networks,
            'Limits': {key: node['HostConfig'].get(key) for key in ['NanoCpus', 'Memory', 'MemorySwap', 'PidsLimit']},
            'Environment': {key: env[key] for key in ['WORKLOAD_REF', 'WORKLOAD_DURATION'] if key in env}}


def image_snapshot(image):
    return {key: image.get(key) for key in ['Id', 'RepoTags', 'RepoDigests', 'Architecture', 'Os', 'Created']}


def redact_compose(document):
    result = json.loads(json.dumps(document))
    for service in result.get('services', {}).values():
        service['environment'] = {key: value if key in ['WORKLOAD_REF', 'WORKLOAD_DURATION'] else '[redacted]'
                                  for key, value in service.get('environment', {}).items()}
        for key in ['command', 'entrypoint', 'env_file']:
            if key in service:
                service[key] = '[redacted]'
        if isinstance(service.get('build'), dict) and 'args' in service['build']:
            service['build']['args'] = {key: '[redacted]' for key in service['build']['args']}
        if 'test' in service.get('healthcheck', {}):
            service['healthcheck']['test'] = '[redacted]'
    for kind in ['secrets', 'configs']:
        for entry in result.get(kind, {}).values():
            if isinstance(entry, dict) and 'content' in entry:
                entry['content'] = '[redacted]'
    return result


def infrastructure(args):
    def output(command):
        return subprocess.check_output(command, text=True, timeout=20)
    nodes = {}
    addresses = {}
    for service in ['database-1', 'database-2', 'storage-1', 'prometheus']:
        ids = output(compose_args(args) + ['ps', '-a', '-q', service]).split()
        if len(ids) != 1:
            raise RuntimeError(f'Expected exactly one {service} container, found {len(ids)}')
        node = json.loads(output(docker_args(args.context) + ['inspect', ids[0]]))[0]
        addresses[service] = validate_node(node, service, args.project, args.network)
        nodes[service] = node
    if addresses['database-1'] == addresses['database-2']:
        raise RuntimeError('Database nodes must have distinct addresses')
    images = json.loads(output(docker_args(args.context) + ['image', 'inspect',
                              *sorted({node['Image'] for node in nodes.values()})]))
    ports = nodes['prometheus']['NetworkSettings']['Ports'].get('9090/tcp') or []
    prometheus_url = None
    if ports:
        host = ports[0]['HostIp']
        host = '127.0.0.1' if host in ['', '0.0.0.0'] else '::1' if host == '::' else host
        host = f'[{host}]' if ':' in host else host
        prometheus_url = f"http://{host}:{ports[0]['HostPort']}"
    return {'container_ids': {service: node['Id'] for service, node in nodes.items()}, 'ips': addresses,
            'network': args.network, 'prometheus_url': prometheus_url, 'nodes': nodes,
            'images': [image_snapshot(image) for image in images],
            'effective_compose': redact_compose(json.loads(output(compose_args(args) + ['config', '--format', 'json'])))}


def fault_plan(infra):
    return [{'at_seconds': offset, 'fault': kind, 'target': service,
             'target_id': infra['container_ids'][service], 'duration_seconds': duration}
            for offset, kind, service, duration in SCHEDULE]


class Runner:
    def __init__(self, args):
        self.args = args
        self.stop = threading.Event()
        self.observer_stop = threading.Event()
        self.signal_number = None
        self.lock = threading.Lock()
        self.background = []
        self.open_files = []
        self.observer_errors = []
        self.completed = []
        self.out = Path(args.output).resolve()
        self.out.mkdir(parents=True, exist_ok=False)
        self.journal = self.out / 'journal.jsonl'
        self.infra = infrastructure(args)
        self.targets = {name: self.infra['container_ids'][name] for name in ['database-1', 'database-2']}
        self.ips = self.infra['ips']
        self.workload = None
        self.start = None
        self.ref = None
        self.comment = 'topic-chaos-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S')
        self.event_path = self.out / 'project-events.jsonl'
        self.observer = None
        self.armed = False

    def record(self, action, outcome, target=None, **details):
        entry = {'time': now(), 'elapsed': round(time.time() - self.start, 3) if self.start else None,
                 'action': action, 'outcome': outcome, 'target_id': target, **details}
        with self.lock:
            with self.journal.open('a') as stream:
                stream.write(json.dumps(entry, ensure_ascii=False) + '\n')
        print(f"{entry['time']} {action} {outcome}" + (f" {details}" if details else ''), flush=True)

    def command(self, args, timeout=20, check=True):
        result = subprocess.run(docker_args(self.args.context) + args, capture_output=True, text=True, timeout=timeout)
        if check and result.returncode:
            raise RuntimeError(f"docker {args}: exit {result.returncode}: {result.stderr.strip()}")
        return result

    def inspect(self, cid):
        return json.loads(self.command(['inspect', cid]).stdout)[0]

    def signal(self, number, _frame):
        self.signal_number = number
        self.stop.set()

    def check_stop(self):
        if self.stop.is_set():
            raise InterruptedError('Runner interrupted')

    def wait_until(self, deadline):
        while time.time() < deadline:
            self.check_stop()
            self.stop.wait(min(1.0, max(0.0, deadline - time.time())))
        self.check_stop()

    def wait_condition(self, predicate, timeout, description):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.check_stop()
            value = predicate()
            if value:
                return value
            self.stop.wait(0.5)
        raise RuntimeError(f'Timeout: {description}')

    def probe(self, service, expected):
        cid = self.targets[service]
        result = self.command(['exec', self.workload, 'node', '-e', PROBE, self.ips[service]], check=False)
        try:
            detail = json.loads(result.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            detail = {'stdout': result.stdout, 'stderr': result.stderr}
        ok = result.returncode == expected and detail.get('reason') == ('timeout' if expected == 2 else 'connected')
        self.record('tcp_probe', 'passed' if ok else 'failed', cid, expected_exit=expected,
                    actual_exit=result.returncode, detail=detail)
        if not ok:
            raise RuntimeError(f'TCP probe for {service} did not produce expected result {expected}')

    def preflight(self):
        workload = self.inspect(self.args.workload_container)
        self.workload = workload['Id']
        if not workload['State']['Running'] or workload['State']['Paused']:
            raise RuntimeError('Workload must already be running and unpaused')
        self.start = parse_time(workload['State']['StartedAt'])
        self.ref = next((entry.split('=', 1)[1] for entry in workload['Config']['Env']
                         if entry.startswith('WORKLOAD_REF=')), None)
        if not self.ref:
            raise RuntimeError('Workload must set WORKLOAD_REF for metric attribution')
        duration = next((entry.split('=', 1)[1] for entry in workload['Config']['Env']
                         if entry.startswith('WORKLOAD_DURATION=')), None)
        if duration is None or float(duration) != self.args.duration:
            raise RuntimeError('WORKLOAD_DURATION must match the runner duration')
        if time.time() - self.start > SCHEDULE[0][0] - 5:
            raise RuntimeError('Runner started too late to execute the complete fault schedule')
        expected_network = self.args.network
        if expected_network not in workload['NetworkSettings']['Networks']:
            raise RuntimeError('Workload is outside the isolated chaos network')
        for service, cid in self.targets.items():
            node = self.inspect(cid)
            address = validate_node(node, service, self.args.project, expected_network)
            if not node['State']['Running'] or node['State']['Paused']:
                raise RuntimeError(f'Target is not running/unpaused: {service}')
            if address != self.ips[service]:
                raise RuntimeError(f'Target IP changed: {service}')
            self.probe(service, 0)
        self.command(['exec', '-u', '0', self.targets['database-2'], 'iptables', '-S'])
        metadata = {'started_at': now(), 'workload_id': self.workload, 'workload_started_at': workload['State']['StartedAt'],
                    'workload_image_id': workload['Image'], 'workload_ref': self.ref, 'project': self.args.project,
                    'targets': self.targets, 'schedule': SCHEDULE, 'duration': self.args.duration,
                    'rule_comment': self.comment, 'runner_pid': os.getpid(), 'runner_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
        (self.out / 'run.json').write_text(json.dumps(metadata, indent=2) + '\n')
        (self.out / 'runner-source.py').write_bytes(Path(__file__).read_bytes())
        (self.out / 'effective-compose.redacted.json').write_text(json.dumps(self.infra['effective_compose'], indent=2) + '\n')
        (self.out / 'containers-preflight.json').write_text(json.dumps(
            [snapshot(node) for node in [*self.infra['nodes'].values(), workload]], indent=2) + '\n')
        workload_image = json.loads(self.command(['image', 'inspect', workload['Image']]).stdout)[0]
        (self.out / 'images.json').write_text(json.dumps(
            [*self.infra['images'], image_snapshot(workload_image)], indent=2) + '\n')
        if not self.infra['prometheus_url']:
            raise RuntimeError('Prometheus service must publish port 9090 for artifact export')
        with urllib.request.urlopen(self.infra['prometheus_url'] + '/-/ready', timeout=5) as response:
            if response.status != 200:
                raise RuntimeError('Prometheus is not ready for artifact export')
        self.record('preflight', 'passed', self.workload)
        self.armed = True

    def background_capture(self, args, file):
        output = (self.out / file).open('w')
        self.open_files.append(output)
        proc = subprocess.Popen(docker_args(self.args.context) + args, stdout=output, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
        self.background.append(proc)

    def start_observers(self):
        started = dt.datetime.fromtimestamp(self.start, dt.timezone.utc).isoformat()
        self.background_capture(['events', '--since', started, '--filter', f'label=com.docker.compose.project={self.args.project}',
                                 '--format', '{{json .}}'], 'project-events.jsonl')
        self.background_capture(['events', '--since', started, '--filter', f'container={self.workload}',
                                 '--format', '{{json .}}'], 'workload-events.jsonl')
        self.background_capture(['logs', '--timestamps', '--follow', '--since', started, self.workload], 'workload-live.log')
        self.observer = threading.Thread(target=self.sample, daemon=True)
        self.observer.start()

    def sample(self):
        ids = [self.infra['container_ids'][name] for name in ['storage-1', 'database-1', 'database-2', 'prometheus']]
        ids.append(self.workload)
        while not self.observer_stop.is_set():
            try:
                timestamp = now()
                states = json.loads(self.command(['inspect', *ids], timeout=20).stdout)
                with (self.out / 'states.jsonl').open('a') as output:
                    for state in states:
                        output.write(json.dumps({'time': timestamp, 'id': state['Id'], 'name': state['Name'],
                                                 'state': state['State'], 'restart_count': state['RestartCount']}) + '\n')
                stats = self.command(['stats', '--no-stream', '--format', '{{json .}}', *ids], timeout=20)
                with (self.out / 'stats.jsonl').open('a') as output:
                    for line in stats.stdout.splitlines():
                        output.write(json.dumps({'time': timestamp, 'stats': json.loads(line)}) + '\n')
            except Exception as error:
                self.observer_errors.append(str(error))
                self.record('observer', 'failed', error=str(error))
            self.observer_stop.wait(self.args.sample_interval)

    def event(self, target, action, since_ns, **attrs):
        if not self.event_path.exists():
            return None
        for line in self.event_path.read_text().splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            actor = event.get('Actor', {})
            if actor.get('ID') != target or event.get('Action', event.get('status')) != action:
                continue
            if int(event.get('timeNano', 0)) < since_ns:
                continue
            actual = actor.get('Attributes', {})
            if all(str(actual.get(key)) == str(value) for key, value in attrs.items()):
                return event
        return None

    def recover(self, service, previous_start=None):
        cid = self.targets[service]
        def healthy():
            state = self.inspect(cid)['State']
            if not state['Running'] or state['Paused'] or state.get('Health', {}).get('Status') != 'healthy':
                return None
            if previous_start is not None and state['StartedAt'] == previous_start:
                return None
            return state
        state = self.wait_condition(healthy, 120, f'{service} recovery')
        self.probe(service, 0)
        self.record('recovery', 'passed', cid, state=state)

    def fault(self, offset, kind, service, duration):
        self.check_stop()
        workload = self.inspect(self.workload)['State']
        if not workload['Running']:
            raise RuntimeError('Workload exited before the fault schedule completed')
        cid = self.targets[service]
        before = self.inspect(cid)
        self.record('fault_begin', 'requested', cid, scheduled_offset=offset, kind=kind, service=service)
        if kind == 'kill':
            since_ns = time.time_ns() - 5_000_000_000
            self.command(['kill', '--signal', 'SIGKILL', cid])
            killed = self.wait_condition(lambda: self.event(cid, 'kill', since_ns, signal='9'), 20,
                                         f'{service} SIGKILL signal 9 event')
            died = self.wait_condition(lambda: self.event(cid, 'die', since_ns, exitCode='137'), 20,
                                       f'{service} SIGKILL exit 137 event')
            self.record('kill_verify', 'passed', cid, kill_event=killed, die_event=died, previous_started_at=before['State']['StartedAt'])
            self.command(['start', cid])
            self.recover(service, before['State']['StartedAt'])
        elif kind == 'pause':
            self.command(['pause', cid])
            state = self.inspect(cid)['State']
            if not state['Paused']:
                raise RuntimeError(f'{service} pause was not applied')
            self.record('pause_verify', 'passed', cid, state=state)
            self.wait_until(time.time() + duration)
            self.command(['unpause', cid])
            self.recover(service)
        elif kind == 'drop':
            rule = ['INPUT', '-p', 'tcp', '--dport', '2136', '-m', 'comment', '--comment', self.comment, '-j', 'DROP']
            self.command(['exec', '-u', '0', cid, 'iptables', '-I', rule[0], '1', *rule[1:]])
            installed = time.time()
            self.command(['exec', '-u', '0', cid, 'iptables', '-C', *rule])
            self.record('drop_verify', 'passed', cid, rule=rule)
            self.probe(service, 2)
            self.wait_until(installed + duration)
            self.command(['exec', '-u', '0', cid, 'iptables', '-D', *rule])
            absent = self.command(['exec', '-u', '0', cid, 'iptables', '-C', *rule], check=False)
            if absent.returncode != 1:
                raise RuntimeError('Own DROP rule remains or verification failed')
            self.recover(service)
        self.completed.append({'offset': offset, 'kind': kind, 'target_id': cid})
        self.record('fault_end', 'passed', cid, scheduled_offset=offset, kind=kind)

    def cleanup(self):
        if not self.armed:
            return []
        errors = []
        rule = ['INPUT', '-p', 'tcp', '--dport', '2136', '-m', 'comment', '--comment', self.comment, '-j', 'DROP']
        for service, cid in self.targets.items():
            try:
                state = self.inspect(cid)['State']
                if state['Paused']:
                    self.command(['unpause', cid])
                if not state['Running']:
                    self.command(['start', cid])
                if service == 'database-2':
                    for _ in range(8):
                        present = self.command(['exec', '-u', '0', cid, 'iptables', '-C', *rule], check=False)
                        if present.returncode == 1:
                            break
                        if present.returncode != 0:
                            raise RuntimeError(present.stderr)
                        self.command(['exec', '-u', '0', cid, 'iptables', '-D', *rule])
                    else:
                        raise RuntimeError('Too many duplicate own DROP rules')
                state = self.inspect(cid)['State']
                if not state['Running'] or state['Paused']:
                    raise RuntimeError('Cleanup left the target stopped or paused')
                self.record('cleanup', 'passed', cid, service=service)
            except Exception as error:
                errors.append(f'{service}: {error}')
                self.record('cleanup', 'failed', cid, service=service, error=str(error))
        return errors

    def capture_final(self):
        errors = []
        if self.workload is None or self.start is None:
            return errors
        started = dt.datetime.fromtimestamp(self.start, dt.timezone.utc).isoformat()
        for service, cid in [*self.targets.items(), ('storage-1', self.infra['container_ids']['storage-1']),
                             ('prometheus', self.infra['container_ids']['prometheus']), ('workload', self.workload)]:
            try:
                logs = self.command(['logs', '--timestamps', '--since', started, cid], timeout=40)
                (self.out / f'{service}.log').write_text(logs.stdout + logs.stderr)
                (self.out / f'{service}-inspect.json').write_text(json.dumps(snapshot(self.inspect(cid)), indent=2) + '\n')
            except Exception as error:
                errors.append(f'{service} artifacts: {error}')
        try:
            prometheus_url = self.infra['prometheus_url']
            quoted_ref = json.dumps(self.ref)
            queries = {'sdk-metrics': '{__name__=~"sdk_.*",ref=' + quoted_ref + '}',
                       'memory': '{__name__=~"sdk_memory_usage(_bytes)?",ref=' + quoted_ref + '}',
                       'topic-progress': '{__name__=~"sdk_topic_.*",ref=' + quoted_ref + '}',
                       'infra-up': 'up'}
            for name, query in queries.items():
                params = urllib.parse.urlencode({'query': query, 'start': self.start, 'end': time.time(), 'step': 5})
                with urllib.request.urlopen(f'{prometheus_url}/api/v1/query_range?{params}', timeout=30) as response:
                    result = json.load(response)
                (self.out / f'prometheus-{name}.json').write_text(json.dumps({'query': query, 'response': result}) + '\n')
                if result.get('status') != 'success':
                    raise RuntimeError(f'Prometheus query {name} failed: {result}')
                if name in ['memory', 'topic-progress'] and not result.get('data', {}).get('result'):
                    raise RuntimeError(f'Prometheus query {name} returned no series for ref {self.ref}')
        except Exception as error:
            errors.append(f'Prometheus artifacts: {error}')
        return errors

    def stop_observers(self):
        self.observer_stop.set()
        if self.observer:
            self.observer.join(timeout=45)
            if self.observer.is_alive():
                self.observer_errors.append('Observer did not stop within 45 seconds')
        for proc in self.background:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)
        for output in self.open_files:
            output.close()

    def run(self):
        failure = None
        exit_code = 0
        cleanup_errors = []
        artifact_errors = []
        for number in [signal.SIGINT, signal.SIGTERM]:
            signal.signal(number, self.signal)
        try:
            self.preflight()
            self.start_observers()
            for offset, kind, target, duration in SCHEDULE:
                deadline = self.start + offset
                self.wait_until(deadline)
                if time.time() - deadline > 10:
                    raise RuntimeError(f'Missed fault deadline at {offset}s')
                self.fault(offset, kind, target, duration)
            self.wait_until(self.start + self.args.duration)
            state = self.wait_condition(lambda: (lambda s: s if not s['Running'] else None)(self.inspect(self.workload)['State']),
                                        self.args.completion_timeout, 'workload completion and integrity verdict')
            (self.out / 'workload-exit.json').write_text(json.dumps(state, indent=2) + '\n')
            if state['ExitCode'] != 0 or state['OOMKilled']:
                raise RuntimeError(f'Workload failed: {state}')
            if len(self.completed) != len(SCHEDULE):
                raise RuntimeError('Fault schedule incomplete')
            self.record('workload_exit', 'passed', self.workload, exit_code=state['ExitCode'])
        except BaseException as error:
            failure = str(error)
            exit_code = 128 + self.signal_number if self.signal_number else 1
            self.record('runner', 'failed', error=failure)
        finally:
            cleanup_errors = self.cleanup()
            artifact_errors = self.capture_final()
            self.stop_observers()
            if cleanup_errors or artifact_errors or self.observer_errors:
                exit_code = exit_code or 1
            summary = {'finished_at': now(), 'exit_code': exit_code, 'failure': failure, 'completed_faults': self.completed,
                       'required_faults': len(SCHEDULE), 'cleanup_errors': cleanup_errors,
                       'artifact_errors': artifact_errors, 'observer_errors': self.observer_errors}
            (self.out / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
            self.record('runner_summary', 'passed' if exit_code == 0 else 'failed', **summary)
        return exit_code


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--context', help='Docker context; omitted uses the current context')
    parser.add_argument('--project', required=True)
    parser.add_argument('--compose-file', required=True)
    parser.add_argument('--network', required=True)
    parser.add_argument('--workload-container')
    parser.add_argument('--output')
    parser.add_argument('--duration', type=int, default=900)
    parser.add_argument('--completion-timeout', type=int, default=180)
    parser.add_argument('--sample-interval', type=int, default=10)
    parser.add_argument('--plan', action='store_true')
    args = parser.parse_args()
    if args.plan:
        print(json.dumps(fault_plan(infrastructure(args)), indent=2))
        return 0
    if not args.workload_container or not args.output:
        parser.error('--workload-container and --output are required')
    if args.duration < 900 or args.sample_interval < 1 or args.completion_timeout < 1:
        parser.error('duration must be >=900; sample interval and completion timeout must be positive')
    return Runner(args).run()


if __name__ == '__main__':
    sys.exit(main())
