"""Run a Node 24+ command with live LLM settings supplied by the environment."""
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


def live_environment(source=None):
    """Validate configuration without reading credential files or making requests."""
    env = dict(os.environ if source is None else source)
    required = ('AEGIS_LLM_PROVIDER', 'AEGIS_LLM_MODEL', 'AEGIS_LLM_BASE_URL', 'AEGIS_LLM_API_KEY')
    missing = [name for name in required if not env.get(name, '').strip()]
    if missing:
        raise ValueError('Missing required environment variables: ' + ', '.join(missing))
    if env['AEGIS_LLM_PROVIDER'] not in ('openai', 'anthropic'):
        raise ValueError('AEGIS_LLM_PROVIDER must be openai or anthropic')
    try:
        base = urlsplit(env['AEGIS_LLM_BASE_URL'])
        valid_url = base.scheme in ('http', 'https') and bool(base.hostname) and base.port != 0
    except ValueError:
        valid_url = False
    if not valid_url or base.username or base.password or base.query or base.fragment:
        raise ValueError('AEGIS_LLM_BASE_URL must be an HTTP(S) API base URL without credentials, query, or fragment')
    try:
        timeout = int(env.get('AEGIS_LLM_TIMEOUT_MS', '10000'))
    except ValueError:
        timeout = 0
    if not 1 <= timeout <= 30000:
        raise ValueError('AEGIS_LLM_TIMEOUT_MS must be an integer from 1 to 30000')
    env['AEGIS_LLM_MODE'] = 'live'
    env['AEGIS_LLM_TIMEOUT_MS'] = str(timeout)
    env.setdefault('AEGIS_MODE', 'mock')
    return env


def prepare_node_environment(source=None):
    """Copy the environment and verify the Node runtime without requiring an LLM."""
    env = dict(os.environ if source is None else source)
    configured = env.get('AEGIS_NODE_BINARY')
    node = shutil.which(configured or 'node', path=env.get('PATH', ''))
    if not node:
        raise ValueError('Node 24+ was not found; add it to PATH or set AEGIS_NODE_BINARY to its executable')
    try:
        version = subprocess.run([node, '--version'], capture_output=True, text=True, check=False)
    except OSError as error:
        raise ValueError('Cannot execute Node; check AEGIS_NODE_BINARY and PATH') from error
    match = re.fullmatch(r'v(\d+)\.\d+\.\d+(?:-\S+)?', version.stdout.strip())
    if version.returncode or not match or int(match[1]) < 24:
        raise ValueError('Node 24+ is required; update PATH or set AEGIS_NODE_BINARY')
    node = str(Path(node).resolve())
    env['PATH'] = str(Path(node).parent) + os.pathsep + env.get('PATH', '')
    return node, env


def prepare_environment(source=None):
    env = live_environment(source)
    return prepare_node_environment(env)


def main(args=None):
    args = list(sys.argv[1:] if args is None else args)
    try:
        node, env = prepare_environment()
        if args == ['--check']:
            print('Live LLM environment and Node 24+ verified; no model request was sent.')
            return 0
        command = args or ['--import', 'tsx', 'scripts/live-intent-smoke.mts']
        return subprocess.run([node, *command], cwd=ROOT, env=env).returncode
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == '__main__':
    raise SystemExit(main())
