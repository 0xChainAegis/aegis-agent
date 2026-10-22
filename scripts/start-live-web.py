"""Start the web UI and live LLM backend against an explicitly selected chain."""
import argparse
import json
import os
from pathlib import Path
import runpy
import signal
import socket
import subprocess
import sys
import time
import re
from urllib.parse import urlsplit
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
_launcher = runpy.run_path(str(ROOT / 'scripts/with-live-llm.py'))


def launch_plan(source=None, root=ROOT, network=None):
    supplied = os.environ if source is None else source
    mode = {'local': 'local_chain', 'sepolia': 'testnet'}.get(network) if network else supplied.get('AEGIS_MODE', 'local_chain')
    if mode not in ('local_chain', 'testnet'):
        raise ValueError('Choose --network local or --network sepolia; no automatic network fallback')
    node, env = _launcher['prepare_environment'](source)
    env['AEGIS_MODE'] = mode
    chain_id = '11155111' if mode == 'testnet' else '31337'
    if env.get('AEGIS_CHAIN_ID', chain_id) != chain_id:
        raise ValueError('AEGIS_CHAIN_ID does not match the selected network')
    env['AEGIS_CHAIN_ID'] = chain_id
    deployment = None
    if mode == 'testnet':
        deployment = validate_sepolia_environment(env)
    if env.get('AEGIS_PORT', '3001') != '3001':
        raise ValueError('The local Vite proxy requires AEGIS_PORT=3001')
    if 'AEGIS_DB_PATH' not in env:
        database = f"web-live-sepolia-{deployment['walletAddress'].lower()}.sqlite" if deployment else f'web-live-local-{uuid4().hex}.sqlite'
        env['AEGIS_DB_PATH'] = str(root / 'backend/data' / database)
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


def validate_sepolia_environment(env):
    """Configuration-only checks; never send credentials or chain transactions."""
    required = ('AEGIS_DEPLOYMENT_FILE', 'AEGIS_RPC_URL', 'AEGIS_AGENT_PRIVATE_KEY')
    missing = [name for name in required if not env.get(name, '').strip()]
    if missing:
        raise ValueError('Sepolia requires: ' + ', '.join(missing))
    try:
        rpc = urlsplit(env['AEGIS_RPC_URL'])
        valid_rpc = rpc.scheme == 'https' and bool(rpc.hostname) and rpc.port != 0
    except ValueError:
        valid_rpc = False
    if not valid_rpc or rpc.username or rpc.password or rpc.fragment:
        raise ValueError('Sepolia RPC must use HTTPS without embedded login credentials or fragment')
    key = env['AEGIS_AGENT_PRIVATE_KEY']
    if not re.fullmatch(r'0x[0-9a-fA-F]{64}', key):
        raise ValueError('AEGIS_AGENT_PRIVATE_KEY must be a 32-byte hexadecimal executor key')
    if key.lower() in {
        '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
        '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        '0x' + '0' * 63 + '1',
    }:
        raise ValueError('A public development key cannot be used on Sepolia')
    try:
        deployment = json.loads(Path(env['AEGIS_DEPLOYMENT_FILE']).read_text(encoding='utf-8-sig'))
    except (OSError, ValueError):
        raise ValueError('Sepolia deployment JSON is missing or invalid') from None
    if not isinstance(deployment, dict) or deployment.get('chainId') != 11155111:
        raise ValueError('Sepolia deployment must declare chainId 11155111')
    addresses = ('walletAddress', 'aclAddress', 'attestationAddress', 'oracleAddress', 'policyEngineAddress',
                 'feedAddress', 'ownerAddress', 'agentAddress', 'recipientAddress')
    if any(not isinstance(deployment.get(name), str)
           or not re.fullmatch(r'0x[0-9a-fA-F]{40}', deployment[name])
           or int(deployment[name][2:], 16) == 0 for name in addresses):
        raise ValueError('Sepolia deployment requires all nine nonzero contract and identity addresses, including PolicyEngine')
    if len({deployment[name].lower() for name in ('ownerAddress', 'agentAddress', 'recipientAddress')}) != 3:
        raise ValueError('Sepolia Owner, executor and recipient must be distinct')
    return deployment


def check_local_chain(env, root=ROOT):
    for port in (3001, 5173):
        with socket.socket() as sock:
            sock.settimeout(1)
            if sock.connect_ex(('127.0.0.1', port)) == 0:
                raise ValueError(f'Port {port} is occupied; stop the existing service before starting another')
    if env.get('AEGIS_MODE', 'local_chain') == 'local_chain':
        with socket.socket() as sock:
            sock.settimeout(1)
            if sock.connect_ex(('127.0.0.1', 8545)) != 0:
                raise ValueError('Start the local chain first; see docs/LLM-LIVE-LOCAL.md')
    deployment = Path(env.get('AEGIS_DEPLOYMENT_FILE', root / 'contracts/deployments/localhost.json'))
    if not deployment.is_file():
        raise ValueError('Selected deployment file is missing; deploy the contracts first')


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
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument('--network', choices=('local', 'sepolia'))
        parser.add_argument('--check', action='store_true')
        options = parser.parse_args(args)
        env, commands = launch_plan(network=options.network) if options.network else launch_plan()
        if options.check:
            print('Selected chain configuration, live LLM environment, Node 24+, and Vite checked; no RPC/model request or payment was sent.')
            return 0
        check_local_chain(env)
        return run_services(env, commands)
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
