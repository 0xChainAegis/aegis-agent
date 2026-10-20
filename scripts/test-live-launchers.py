"""Offline launcher regression tests: no API requests, sockets, or web services."""
from contextlib import redirect_stdout
import io
import os
from pathlib import Path
import runpy
import signal
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
live = runpy.run_path(str(ROOT / 'scripts/with-live-llm.py'))
web = runpy.run_path(str(ROOT / 'scripts/start-live-web.py'))


def configured():
    return {
        'AEGIS_LLM_PROVIDER': 'openai', 'AEGIS_LLM_MODEL': 'offline-test-model',
        'AEGIS_LLM_BASE_URL': 'https://example.invalid/custom-api',
        'AEGIS_LLM_API_KEY': 'offline-placeholder', 'PATH': 'original-path',
    }


class LauncherTests(unittest.TestCase):
    def test_missing_settings_fail_before_runtime_or_child_execution(self):
        with patch.object(subprocess, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'AEGIS_LLM_API_KEY'):
                live['prepare_environment']({'AEGIS_LLM_PROVIDER': 'openai'})
            run.assert_not_called()

    def test_environment_preserves_selected_provider_model_endpoint_and_secret(self):
        source = configured()
        env = live['live_environment'](source)
        for key in source:
            self.assertEqual(env[key], source[key])
        self.assertEqual(env['AEGIS_MODE'], 'mock')
        self.assertEqual(env['AEGIS_LLM_MODE'], 'live')
        self.assertEqual(env['AEGIS_LLM_TIMEOUT_MS'], '10000')
        self.assertNotIn('AEGIS_MODE', source)
        with self.assertRaisesRegex(ValueError, 'AEGIS_LLM_BASE_URL'):
            live['live_environment']({**source, 'AEGIS_LLM_BASE_URL': 'https://user:password@example.invalid'})
        with self.assertRaisesRegex(ValueError, 'AEGIS_LLM_TIMEOUT_MS'):
            live['live_environment']({**source, 'AEGIS_LLM_TIMEOUT_MS': '30001'})

    def test_node_from_path_or_explicit_binary_requires_version_24(self):
        for explicit in (False, True):
            source = configured()
            if explicit:
                source['AEGIS_NODE_BINARY'] = 'chosen-node'
            with patch('shutil.which', return_value='/tools/node') as which, patch.object(subprocess, 'run', return_value=Mock(returncode=0, stdout='v24.1.0\n')) as run:
                node, env = live['prepare_environment'](source)
                which.assert_called_once_with('chosen-node' if explicit else 'node', path='original-path')
                self.assertTrue(env['PATH'].endswith(os.pathsep + 'original-path'))
                run.assert_called_once_with(['/tools/node', '--version'], capture_output=True, text=True, check=False)
                self.assertEqual(Path(node).name, 'node')
            with patch('shutil.which', return_value='/tools/node'), patch.object(subprocess, 'run', return_value=Mock(returncode=0, stdout='v22.1.0')):
                with self.assertRaisesRegex(ValueError, 'Node 24'):
                    live['prepare_environment'](source)

    def test_web_plan_uses_fresh_db_preserves_override_and_resolves_workspace_vite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            vite = root / 'node_modules/vite/bin/vite.js'
            vite.parent.mkdir(parents=True)
            vite.touch()
            launcher = web['launch_plan'].__globals__['_launcher']
            with patch.dict(launcher, {'prepare_environment': lambda source: ('node', dict(source))}):
                first, commands = web['launch_plan'](configured(), root)
                second, _ = web['launch_plan'](configured(), root)
                self.assertNotEqual(first['AEGIS_DB_PATH'], second['AEGIS_DB_PATH'])
                self.assertEqual(Path(first['AEGIS_DB_PATH']).parent, root / 'backend/data')
                self.assertEqual(first['AEGIS_MODE'], 'local_chain')
                self.assertEqual(commands[1][0][1], str(vite))
                explicit, _ = web['launch_plan']({**configured(), 'AEGIS_DB_PATH': 'selected.sqlite'}, root)
                self.assertEqual(explicit['AEGIS_DB_PATH'], 'selected.sqlite')
                vite.unlink()
                fallback = root / 'frontend/node_modules/vite/bin/vite.js'
                fallback.parent.mkdir(parents=True)
                fallback.touch()
                self.assertEqual(web['launch_plan'](configured(), root)[1][1][0][1], str(fallback))

    def test_check_modes_do_not_call_models_open_sockets_or_start_children(self):
        with patch.dict(live['main'].__globals__, {'prepare_environment': lambda: ('node', configured())}), patch.object(subprocess, 'run') as run, redirect_stdout(io.StringIO()):
            self.assertEqual(live['main'](['--check']), 0)
            run.assert_not_called()
        with patch.dict(web['main'].__globals__, {'launch_plan': lambda: (configured(), []), 'check_local_chain': Mock(side_effect=AssertionError('must not probe ports'))}), patch.object(subprocess, 'Popen') as start, redirect_stdout(io.StringIO()):
            self.assertEqual(web['main'](['--check']), 0)
            start.assert_not_called()

    def test_sibling_is_stopped_when_one_process_exits(self):
        first, second = Mock(pid=101), Mock(pid=102)
        first.poll.side_effect = [7, 7]
        second.poll.return_value = None
        commands = [(['node', 'backend'], ROOT), (['node', 'frontend'], ROOT)]
        with patch.object(subprocess, 'Popen', side_effect=[first, second]), patch.object(subprocess, 'run') as stop, patch('os.killpg', create=True) as kill, redirect_stdout(io.StringIO()):
            self.assertEqual(web['run_services'](configured(), commands), 7)
            if os.name == 'nt':
                self.assertEqual(stop.call_args.args[0], ['taskkill', '/PID', '102', '/T', '/F'])
            else:
                kill.assert_called_once_with(102, signal.SIGTERM)
            first.wait.assert_called_once_with(timeout=5)
            second.wait.assert_called_once_with(timeout=5)

    def test_posix_cleanup_terminates_process_groups_and_escalates_after_timeout(self):
        child = Mock(pid=103)
        child.poll.return_value = None
        child.wait.side_effect = [subprocess.TimeoutExpired('offline-child', 5), None]
        with patch.object(os, 'name', 'posix'), patch.object(signal, 'SIGKILL', 9, create=True), patch('os.killpg', create=True) as kill:
            web['stop_children']([child])
            self.assertEqual(kill.call_args_list[0].args, (103, signal.SIGTERM))
            self.assertEqual(kill.call_args_list[1].args, (103, signal.SIGKILL))


if __name__ == '__main__':
    unittest.main()

