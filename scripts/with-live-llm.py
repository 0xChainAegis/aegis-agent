"""本机联调入口：从 Hermes wow 凭据池读取密钥，仅传入子进程环境，不复制到项目。"""
import json
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
auth_file = Path(os.environ.get('HERMES_HOME', str(Path.home() / 'AppData/Local/hermes'))) / 'auth.json'
auth = json.loads(auth_file.read_text(encoding='utf-8'))
entries = auth.get('credential_pool', {}).get('custom:wow', [])
entry = next((item for item in entries if item.get('access_token') and item.get('last_status') != 'disabled'), None)
if not entry:
    raise SystemExit('未找到 wow API 密钥，请先在 Hermes 配置 wow 凭据。')
# 凭据池中曾保存管理页面 /keys；只允许已批准主机，API 固定使用 /v1。
from urllib.parse import urlsplit
stored_url = urlsplit(entry.get('base_url') or 'https://wow.wvv.pp.ua/v1')
base_url = 'https://wow.wvv.pp.ua/v1'
if stored_url.scheme != 'https' or stored_url.netloc != 'wow.wvv.pp.ua':
    raise SystemExit('wow 地址与已批准地址不同，停止发送凭据。')
env = os.environ.copy()
env.update({
    'AEGIS_MODE': os.environ.get('AEGIS_MODE', 'mock'),  # 默认仅草稿；网页联调显式选择 local_chain。
    'AEGIS_LLM_MODE': 'live',
    'AEGIS_LLM_PROVIDER': 'openai',
    'AEGIS_LLM_MODEL': 'gpt-6.1-sol',
    'AEGIS_LLM_BASE_URL': base_url,
    'AEGIS_LLM_API_KEY': entry['access_token'],
    'AEGIS_LLM_TIMEOUT_MS': '30000',
})
node = root.parent / '.runtime/node24/node.exe'
if not node.exists():
    raise SystemExit('缺少项目专用 Node 24：' + str(node))
env['PATH'] = str(node.parent) + os.pathsep + env.get('PATH', '')
args = sys.argv[1:] or ['--import', 'tsx', 'scripts/live-intent-smoke.mts']
result = subprocess.run([str(node), *args], cwd=root, env=env)
raise SystemExit(result.returncode)
