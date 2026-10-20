"""本机联调入口（仅适用于项目作者本机，不是团队通用的密钥配置工具）。

密钥来源优先级：
1. 进程环境变量 AEGIS_LLM_API_KEY / AEGIS_LLM_BASE_URL（推荐，任何成员都可用）；
2. 两者缺省时才回退到本机 Hermes 凭据池（AppData/Local/hermes/auth.json 的 custom:wow）。
   该回退依赖本机目录结构与 profile，其他成员不要把这条路径当作文档化的配置方式。

无论走哪条路，密钥只传入子进程环境，不写入项目文件、不打印、不进日志。
"""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

APPROVED_HOST = 'wow.wvv.pp.ua'
root = Path(__file__).resolve().parents[1]


def from_env():
    """方案一：直接使用调用者提供的环境变量。"""
    key = os.environ.get('AEGIS_LLM_API_KEY')
    if not key:
        return None
    base = os.environ.get('AEGIS_LLM_BASE_URL', f'https://{APPROVED_HOST}/v1')
    return key, base, '进程环境变量'


def from_hermes_pool():
    """方案二：本机专用。读取 Hermes 凭据池中的 wow 密钥。"""
    auth_file = Path(os.environ.get('HERMES_HOME', str(Path.home() / 'AppData/Local/hermes'))) / 'auth.json'
    if not auth_file.exists():
        return None
    auth = json.loads(auth_file.read_text(encoding='utf-8'))
    entries = auth.get('credential_pool', {}).get('custom:wow', [])
    entry = next((item for item in entries if item.get('access_token') and item.get('last_status') != 'disabled'), None)
    if not entry:
        return None
    stored = entry.get('base_url') or f'https://{APPROVED_HOST}/v1'
    # 凭据池中曾保存管理页面 /keys；API 固定使用 /v1，且只允许已批准主机。
    from urllib.parse import urlsplit
    parsed = urlsplit(stored)
    if parsed.scheme != 'https' or parsed.netloc != APPROVED_HOST:
        raise SystemExit('wow 地址与已批准地址不同，停止发送凭据。')
    return entry['access_token'], f'https://{APPROVED_HOST}/v1', '本机 Hermes 凭据池（仅本机）'


credential = from_env() or from_hermes_pool()
if not credential:
    raise SystemExit(
        '未找到模型密钥。其他成员请设置 AEGIS_LLM_API_KEY（以及可选的 AEGIS_LLM_BASE_URL）后直接运行 Node 24；'
        '本项目作者的快捷入口才依赖本机 Hermes wow 凭据池。'
    )
key, base_url, source = credential
print(f'[with-live-llm] 密钥来源：{source}')

# Node 24：可显式指定，其次项目相邻的 .runtime/node24，最后退回 PATH 里的 node（需 >=24）。
def find_node():
    explicit = os.environ.get('AEGIS_NODE_EXE')
    if explicit and Path(explicit).exists():
        return explicit
    beside = root.parent / '.runtime/node24/node.exe'
    if beside.exists():
        return str(beside)
    found = shutil.which('node')
    if found:
        return found
    raise SystemExit('缺少 Node 24：请设置 AEGIS_NODE_EXE 指向 node 可执行文件。')


node = find_node()
env = os.environ.copy()
env.update({
    'AEGIS_MODE': os.environ.get('AEGIS_MODE', 'mock'),  # 默认仅草稿；网页联调显式选择 local_chain。
    'AEGIS_LLM_MODE': 'live',
    'AEGIS_LLM_PROVIDER': 'openai',
    'AEGIS_LLM_MODEL': os.environ.get('AEGIS_LLM_MODEL', 'gpt-6.1-sol'),
    'AEGIS_LLM_BASE_URL': base_url,
    'AEGIS_LLM_API_KEY': key,
    # 真实模型延迟约 4 秒，业务默认 2000 ms 会超时；仅在本入口放宽。
    'AEGIS_LLM_TIMEOUT_MS': os.environ.get('AEGIS_LLM_TIMEOUT_MS', '30000'),
})
env['PATH'] = str(Path(node).parent) + os.pathsep + env.get('PATH', '')
args = sys.argv[1:] or ['--import', 'tsx', 'scripts/live-intent-smoke.mts']
result = subprocess.run([node, *args], cwd=root, env=env)
raise SystemExit(result.returncode)
