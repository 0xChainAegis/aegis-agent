"""本机启动前端与真实 LLM 后端；须先启动并部署本地链。"""
import os
from pathlib import Path
import socket
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
node = root.parent / '.runtime/node24/node.exe'
for port in (3001, 5173):
    with socket.socket() as sock:
        if sock.connect_ex(('127.0.0.1', port)) == 0:
            raise SystemExit(f'端口 {port} 已占用；请复用现有服务或先停止，避免重复启动。')
with socket.socket() as sock:
    if sock.connect_ex(('127.0.0.1', 8545)) != 0:
        raise SystemExit('请先按 docs/LLM-LIVE-LOCAL.md 启动本地链并部署。')
if not (root / 'contracts/deployments/localhost.json').exists():
    raise SystemExit('缺少本地部署记录，请先部署。')
env = os.environ.copy()
env['AEGIS_MODE'] = 'local_chain'
env.setdefault('AEGIS_DB_PATH', str(root / 'backend/data/web-live-20261020.sqlite'))
children = []
try:
    children.append(subprocess.Popen([sys.executable, 'scripts/with-live-llm.py', '--import', 'tsx', 'backend/src/index.ts'], cwd=root, env=env))
    children.append(subprocess.Popen([str(node), 'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], cwd=root / 'frontend', env=env))
    print('网页 http://127.0.0.1:5173；Ctrl+C 停止前后端。', flush=True)
    while all(child.poll() is None for child in children):
        try:
            children[0].wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass
finally:
    for child in children:
        if child.poll() is None:
            subprocess.run(['taskkill', '/PID', str(child.pid), '/T', '/F'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
