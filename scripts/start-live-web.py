"""Start the local web UI and live LLM backend against an already deployed chain."""
import os
from pathlib import Path
import runpy
import signal
import socket
import subprocess
import sys
import time
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
_launcher = runpy.run_path(str(ROOT / 'scripts/with-live-llm.py'))


def launch_plan(source=None, root=ROOT):
    node, env = _launcher['prepare_environment'](source)
    env['AEGIS_MODE'] = 'local_chain'
    if env.get('AEGIS_PORT', '3001') != '3001':
        raise ValueError('The local Vite proxy requires AEGIS_PORT=3001')
    if 'AEGIS_DB_PATH' not in env:
        env['AEGIS_DB_PATH'] = str(root / 'backend/data' / f'web-live-{uuid4().hex}.sqlite')
    elif not env['AEGIS_DB_PATH'].strip():
        raise ValueError('AEGIS_DB_PATH must be nonempty when explicitly set')
    # npm workspaces normally hoist Vite to the root; standalone frontend
    # installations may keep it in frontend/node_modules instead.
    vite = next((path for path in (
        root / 'node_modules/vite/bin/vite.js',
        root / 'frontend/node_modules/vite/bin/vite.js',
    ) if path.is_file()), None)
    if vite is None:
        raise ValueError('Vite is missing; install the project dependencies first')
    commands = [
        ([node, '--import', 'tsx', 'backend/src/index.ts'], root),
        ([node, str(vite), '--host', '127.0.0.1', '--port', '5173', '--strictPort'], root / 'frontend'),
    ]
    return env, commands


def check_local_chain(env, root=ROOT):
    for port in (3001, 5173):
        with socket.socket() as sock:
            sock.settimeout(1)
            if sock.connect_ex(('127.0.0.1', port)) == 0:
                raise ValueError(f'Port {port} is occupied; stop the existing service before starting another')
    with socket.socket() as sock:
        sock.settimeout(1)
        if sock.connect_ex(('127.0.0.1', 8545)) != 0:
            raise ValueError('Start the local chain first; see docs/LLM-LIVE-LOCAL.md')
    deployment = Path(env.get('AEGIS_DEPLOYMENT_FILE', root / 'contracts/deployments/localhost.json'))
    if not deployment.is_file():
        raise ValueError('Local deployment file is missing; deploy the local contracts first')


def stop_children(children):
    for child in children:
        if child.poll() is not None:
            continue
        if os.name == 'nt':
            # taskkill also stops descendants of each managed process group.
            subprocess.run(['taskkill', '/PID', str(child.pid), '/T', '/F'],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        else:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    for child in children:
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            if os.name != 'nt':
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            else:
                child.kill()
            child.wait(timeout=5)


def run_services(env, commands):
    children = []
    previous_handlers = {}

    def interrupted(signum, frame):
        raise KeyboardInterrupt

    try:
        for signum in (signal.SIGINT, signal.SIGTERM):
            previous_handlers[signum] = signal.signal(signum, interrupted)
        options = {'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == 'nt' else {'start_new_session': True}
        for command, cwd in commands:
            children.append(subprocess.Popen(command, cwd=cwd, env=env, **options))
        print('Web UI: http://127.0.0.1:5173; Ctrl+C stops both services.', flush=True)
        while True:
            for child in children:
                code = child.poll()
                if code is not None:
                    return code or 1
            time.sleep(0.2)
    except KeyboardInterrupt:
        return 130
    finally:
        try:
            stop_children(children)
        finally:
            for signum, handler in previous_handlers.items():
                signal.signal(signum, handler)


def main(args=None):
    args = list(sys.argv[1:] if args is None else args)
    try:
        if args not in ([], ['--check']):
            raise ValueError('Usage: python scripts/start-live-web.py [--check]')
        env, commands = launch_plan()
        if args == ['--check']:
            print('Live LLM environment, Node 24+, and Vite verified; no services or model requests were started.')
            return 0
        check_local_chain(env)
        return run_services(env, commands)
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
