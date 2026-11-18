import asyncio
import importlib.util
import json
import socket
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
import httpx
import uvicorn

spec = importlib.util.spec_from_file_location(
    'local_image',
    Path(__file__).resolve().parents[1] / 'runtimes/mflux/server.py',
)
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
TOKEN = 'synthetic_local_image_test_token_1234567890'


def install_fixture(root, model=server.MODEL):
    location = root / server.MODELS[model]['directory']
    for name in ['.ready', *server.REGISTRY['requiredFiles']]:
        target = location / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(server.MODELS[model]['revision'] if name == '.ready' else 'fixture')
    return location


class LocalImageTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.flux_root = install_fixture(self.root)
        self.calls = []

        async def runner(payload, root, request):
            self.assertEqual(root, self.root / server.MODELS[payload['model']]['directory'])
            self.calls.append(payload)
            return {'model': payload['model'], 'data': [{'b64_json': 'fixture'}]}

        self.client = TestClient(server.create_app(TOKEN, self.root, 8016, runner),
                                 base_url='http://127.0.0.1:8016',
                                 headers={'Authorization': f'Bearer {TOKEN}'})
        self.addCleanup(self.client.close)
        self.payload = {'model': server.MODEL, 'prompt': 'fox', 'size': '1024x576'}

    def test_auth_host_origin_and_identity(self):
        state = self.client.get('/health').json()
        self.assertEqual(state['protocolVersion'], 2)
        self.assertEqual(state['data'][0]['revision'], server.MODELS[server.MODEL]['revision'])
        manifest = self.client.get('/v1/manifest').json()
        self.assertEqual(manifest['protocol'], 'cursorblinking-provider')
        self.assertEqual(manifest['protocolVersion'], 1)
        capability = manifest['capabilities'][0]
        self.assertEqual(capability['id'], 'image.generate')
        self.assertEqual(
            [model['id'] for model in capability['models']],
            list(server.MODELS),
        )
        self.assertEqual(
            capability['models'][0]['inputModes'],
            ['text', 'reference_image'],
        )
        self.assertEqual(state['data'][0]['maxReferenceImages'], 4)
        for headers, code in [({'Authorization': ''}, 401), ({'Host': 'evil.example'}, 403),
                              ({'Origin': 'https://evil.example'}, 403)]:
            self.assertEqual(self.client.get('/health', headers=headers).status_code, code)
        (self.flux_root / '.ready').unlink()
        self.assertEqual(self.client.get('/health').status_code, 503)

    def test_generation_and_input_boundaries(self):
        self.assertEqual(self.client.post('/v1/images/generations', json=self.payload).status_code, 200)
        self.assertEqual(len(self.calls), 1)
        references = ['data:image/png;base64,YQ==', 'data:image/png;base64,Yg==']
        self.assertEqual(self.client.post('/v1/images/generations', json={
            **self.payload, 'reference_images': references}).status_code, 200)
        self.assertEqual(self.calls[-1]['reference_images'], references)
        for change in [{'model': '../../arbitrary'}, {'model': []}, {'prompt': ''}, {'size': '4096x4096'},
                       {'n': 2}, {'seed': -1}, {'seed': True}, {'steps': 99},
                       {'reference_images': ['http://example.com/image.png']},
                       {'reference_images': ['data:image/png;base64,bad!']},
                       {'reference_images': ['data:image/png;base64,YQ=='] * 5}]:
            result = self.client.post('/v1/images/generations', json={**self.payload, **change})
            self.assertEqual(result.status_code, 422)
            self.assertEqual(result.json(), {'error': {'code': 'REQUEST_INVALID'}})
        self.assertEqual(len(self.calls), 2)
        with patch.object(server, 'MAX_REQUEST_BYTES', 4):
            self.assertEqual(self.client.post('/v1/images/generations', json=self.payload).status_code, 413)

    def test_models_are_independent_and_z_image_rejects_reference_editing(self):
        payload = {**self.payload, 'model': 'z-image-turbo'}
        self.assertEqual(self.client.post('/v1/images/generations', json=payload).status_code, 503)
        z_root = install_fixture(self.root, 'z-image-turbo')
        models = self.client.get('/v1/models').json()['data']
        self.assertEqual([item['id'] for item in models], [server.MODEL, 'z-image-turbo'])
        self.assertEqual(models[1]['modes'], ['text'])
        result = self.client.post('/v1/images/generations', json=payload)
        self.assertEqual(result.json()['model'], 'z-image-turbo')
        rejected = self.client.post('/v1/images/generations', json={**payload,
            'reference_images': ['data:image/png;base64,YQ==']})
        self.assertEqual(rejected.status_code, 422)
        (z_root / '.ready').write_text('wrong-revision')
        self.assertEqual(self.client.post('/v1/images/generations', json=payload).status_code, 503)
        self.assertEqual(self.client.post('/v1/images/generations', json=self.payload).status_code, 200)

    def test_inference_errors_are_redacted(self):
        async def fail(*args):
            raise RuntimeError('private prompt, token, file path')
        with TestClient(server.create_app(TOKEN, self.root, 8016, fail),
                        base_url='http://127.0.0.1:8016',
                        headers={'Authorization': f'Bearer {TOKEN}'}) as client:
            result = client.post('/v1/images/generations', json=self.payload)
        self.assertEqual(result.json(), {'error': {'code': 'INFERENCE_FAILED'}})


class ProcessCleanupTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_http_disconnect_reaps_worker_and_releases_gpu_slot(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            install_fixture(root, 'z-image-turbo')
            listener = socket.socket()
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
            application = server.create_app(TOKEN, root, port)
            runtime = uvicorn.Server(uvicorn.Config(application, log_level='critical', access_log=False))
            transport = asyncio.create_task(runtime.serve(sockets=[listener]))
            worker = None
            started = asyncio.Event()
            real_spawn = asyncio.create_subprocess_exec
            async def spawn(*args, **kwargs):
                nonlocal worker
                worker = await real_spawn(sys.executable, '-c', 'import time; time.sleep(30)', **kwargs)
                started.set()
                return worker
            try:
                for _ in range(50):
                    if runtime.started:
                        break
                    await asyncio.sleep(0.02)
                self.assertTrue(runtime.started)
                with patch.object(server.asyncio, 'create_subprocess_exec', spawn):
                    async with httpx.AsyncClient(base_url=f'http://127.0.0.1:{port}',
                                                 headers={'Authorization': f'Bearer {TOKEN}'}) as client:
                        request = asyncio.create_task(client.post('/v1/images/generations',
                            json={'model': 'z-image-turbo', 'prompt': 'fox', 'size': '768x768'}))
                        await asyncio.wait_for(started.wait(), 2)
                        request.cancel()
                        with self.assertRaises(asyncio.CancelledError):
                            await request
                        await asyncio.wait_for(worker.wait(), 3)
                        self.assertEqual(worker.returncode, -9)
                        health = (await client.get('/health')).json()
                        self.assertFalse(health['busy'])
                        self.assertEqual(health['pending'], 0)
            finally:
                if worker and worker.returncode is None:
                    worker.kill()
                    await worker.wait()
                runtime.should_exit = True
                await asyncio.wait_for(transport, 5)
                listener.close()

    async def test_concurrent_calls_use_one_gpu_slot_and_bounded_waiting(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            install_fixture(root)
            install_fixture(root, 'z-image-turbo')
            started, release = asyncio.Event(), asyncio.Event()
            active, maximum = 0, 0
            async def runner(*args):
                nonlocal active, maximum
                active += 1
                maximum = max(maximum, active)
                started.set()
                await release.wait()
                active -= 1
                return {'data': []}
            app = server.create_app(TOKEN, root, 8016, runner)
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                         base_url='http://127.0.0.1:8016',
                                         headers={'Authorization': f'Bearer {TOKEN}'}) as client:
                payload = {'model': server.MODEL, 'prompt': 'fox', 'size': '1024x576'}
                calls = [asyncio.create_task(client.post('/v1/images/generations', json=payload))]
                await asyncio.wait_for(started.wait(), 2)
                calls.extend(asyncio.create_task(client.post('/v1/images/generations',
                    json={**payload, 'model': 'z-image-turbo'})) for _ in range(3))
                for _ in range(30):
                    if (await client.get('/health')).json()['pending'] == 4:
                        break
                    await asyncio.sleep(0.01)
                self.assertEqual((await client.post('/v1/images/generations', json=payload)).status_code, 429)
                release.set()
                results = await asyncio.wait_for(asyncio.gather(*calls), 5)
                self.assertTrue(all(result.status_code == 200 for result in results))
                self.assertEqual(maximum, 1)

    async def test_disconnect_kills_inference_process(self):
        class Process:
            returncode = None
            killed = False
            async def communicate(self, data):
                await asyncio.sleep(100)
            def kill(self):
                self.killed = True
                self.returncode = -9
            async def wait(self):
                return self.returncode
        class Request:
            async def is_disconnected(self):
                return True
        process = Process()
        async def spawn(*args, **kwargs):
            return process
        with patch.object(server.asyncio, 'create_subprocess_exec', spawn):
            with self.assertRaisesRegex(ValueError, 'CANCELLED'):
                await server.run_inference({}, Path('/synthetic-model'), Request())
        self.assertTrue(process.killed)


if __name__ == '__main__':
    unittest.main()
