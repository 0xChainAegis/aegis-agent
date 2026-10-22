"""Offline launcher regression tests: no API requests, sockets, or web services."""
from contextlib import redirect_stdout
import io
import json
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
    def sepolia_source(self, directory):
        path = Path(directory) / 'sepolia.json'
        deployment = {'chainId': 11155111}
        for index, name in enumerate(('walletAddress', 'aclAddress', 'attestationAddress', 'oracleAddress',
                                      'policyEngineAddress', 'feedAddress', 'ownerAddress', 'agentAddress', 'recipientAddress'), 1):
            deployment[name] = '0x' + format(index, '040x')
        path.write_text(json.dumps(deployment), encoding='utf-8')
        return {**configured(), 'AEGIS_MODE': 'testnet', 'AEGIS_CHAIN_ID': '11155111',
                'AEGIS_DEPLOYMENT_FILE': str(path), 'AEGIS_RPC_URL': 'https://example.invalid/rpc',
                'AEGIS_AGENT_PRIVATE_KEY': '0x' + 'ab' * 32}

    def test_sepolia_selection_is_preserved_and_does_not_require_hardhat(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            vite = root / 'node_modules/vite/bin/vite.js'
            vite.parent.mkdir(parents=True)
            vite.touch()
            source = self.sepolia_source(directory)
            launcher = web['launch_plan'].__globals__['_launcher']
            with patch.dict(launcher, {'prepare_environment': lambda source: ('node', dict(source))}):
                env, commands = web['launch_plan'](source, root)
                self.assertEqual(env['AEGIS_MODE'], 'testnet')
                self.assertEqual(env['AEGIS_CHAIN_ID'], '11155111')
                self.assertEqual(web['launch_plan'](source, root)[0]['AEGIS_DB_PATH'], env['AEGIS_DB_PATH'])
                self.assertEqual(env['AEGIS_AGENT_PRIVATE_KEY'], source['AEGIS_AGENT_PRIVATE_KEY'])
                self.assertTrue(all('hardhat' not in ' '.join(command) for command, _ in commands))
                self.assertIn('sepolia', Path(env['AEGIS_DB_PATH']).name)
                del source['AEGIS_MODE']
                self.assertEqual(web['launch_plan'](source, root, network='sepolia')[0]['AEGIS_MODE'], 'testnet')
            with patch.object(socket_module := web['check_local_chain'].__globals__['socket'], 'socket') as sockets:
                sockets.return_value.__enter__.return_value.connect_ex.return_value = 1
                web['check_local_chain'](env, root)
                self.assertEqual(sockets.call_count, 2)
                self.assertNotIn((('127.0.0.1', 8545),), [call.args for call in sockets.return_value.__enter__.return_value.connect_ex.call_args_list])

    def test_web_plan_can_disable_llm_without_model_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            vite = root / 'node_modules/vite/bin/vite.js'
            vite.parent.mkdir(parents=True)
            vite.touch()
            source = self.sepolia_source(directory)
            for name in ('AEGIS_LLM_PROVIDER', 'AEGIS_LLM_MODEL', 'AEGIS_LLM_BASE_URL', 'AEGIS_LLM_API_KEY'):
                del source[name]
            launcher = web['launch_plan'].__globals__['_launcher']
            prepare_node = Mock(return_value=('node', dict(source)))
            with patch.dict(launcher, {
                'prepare_node_environment': prepare_node,
                'prepare_environment': Mock(side_effect=AssertionError('live LLM validation must not run')),
            }):
                env, commands = web['launch_plan'](source, root, network='sepolia', llm_mode='off')
            self.assertEqual(env['AEGIS_LLM_MODE'], 'off')
            self.assertEqual(env['AEGIS_MODE'], 'testnet')
            self.assertEqual(len(commands), 2)
            prepare_node.assert_called_once_with(source)

    def test_web_plan_honors_off_mode_from_environment_and_rejects_stub(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            vite = root / 'node_modules/vite/bin/vite.js'
            vite.parent.mkdir(parents=True)
            vite.touch()
            source = {**self.sepolia_source(directory), 'AEGIS_LLM_MODE': 'off'}
            launcher = web['launch_plan'].__globals__['_launcher']
            with patch.dict(launcher, {'prepare_node_environment': lambda source: ('node', dict(source))}):
                self.assertEqual(web['launch_plan'](source, root)[0]['AEGIS_LLM_MODE'], 'off')
            with self.assertRaisesRegex(ValueError, '--llm off or --llm live'):
                web['launch_plan']({**source, 'AEGIS_LLM_MODE': 'stub'}, root)

    def test_sepolia_configuration_rejects_missing_wrong_chain_and_public_keys(self):
        validate = web['validate_sepolia_environment']
        with tempfile.TemporaryDirectory() as directory:
            source = self.sepolia_source(directory)
            validate(source)
            for missing in ('AEGIS_DEPLOYMENT_FILE', 'AEGIS_RPC_URL', 'AEGIS_AGENT_PRIVATE_KEY'):
                with self.subTest(missing=missing), self.assertRaisesRegex(ValueError, missing):
                    validate({key: value for key, value in source.items() if key != missing})
            for rpc in ('http://example.invalid', 'https://user:secret@example.invalid', 'not a URL'):
                with self.subTest(rpc=rpc), self.assertRaisesRegex(ValueError, 'HTTPS'):
                    validate({**source, 'AEGIS_RPC_URL': rpc})
            with self.assertRaisesRegex(ValueError, 'public development key'):
                validate({**source, 'AEGIS_AGENT_PRIVATE_KEY': '0x' + '0' * 63 + '1'})
            path = Path(source['AEGIS_DEPLOYMENT_FILE'])
            for document in ([], {'chainId': 31337}, {'chainId': 11155111}):
                path.write_text(json.dumps(document), encoding='utf-8')
                with self.subTest(document=document), self.assertRaises(ValueError):
                    validate(source)
            path.write_text('not json', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'missing or invalid'):
                validate(source)

    def test_sepolia_check_is_offline_and_never_launches_or_pays(self):
        with patch.dict(web['main'].__globals__, {'launch_plan': Mock(return_value=({'AEGIS_MODE': 'testnet'}, [])),
                                                 'check_local_chain': Mock(side_effect=AssertionError('no sockets'))}), \
                patch.object(subprocess, 'Popen') as start, redirect_stdout(io.StringIO()):
            self.assertEqual(web['main'](['--network', 'sepolia', '--check']), 0)
            web['main'].__globals__['launch_plan'].assert_called_once_with(network='sepolia', llm_mode=None)
            start.assert_not_called()

    def test_sepolia_check_passes_explicit_off_mode_to_plan(self):
        plan = Mock(return_value=({'AEGIS_MODE': 'testnet', 'AEGIS_LLM_MODE': 'off'}, []))
        with patch.dict(web['main'].__globals__, {'launch_plan': plan}), redirect_stdout(io.StringIO()):
            self.assertEqual(web['main'](['--network', 'sepolia', '--llm', 'off', '--check']), 0)
        plan.assert_called_once_with(network='sepolia', llm_mode='off')

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

    def test_node_environment_does_not_require_llm_settings(self):
        source = {'PATH': 'original-path'}
        with patch('shutil.which', return_value='/tools/node'), patch.object(
                subprocess, 'run', return_value=Mock(returncode=0, stdout='v24.1.0\n')):
            _, env = live['prepare_node_environment'](source)
        self.assertEqual(env['PATH'], '/tools' + os.pathsep + 'original-path')
        self.assertNotIn('AEGIS_LLM_MODE', env)

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
        with patch.dict(web['main'].__globals__, {'launch_plan': lambda **kwargs: (configured(), []), 'check_local_chain': Mock(side_effect=AssertionError('must not probe ports'))}), patch.object(subprocess, 'Popen') as start, redirect_stdout(io.StringIO()):
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

