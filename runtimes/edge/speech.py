"""Bounded Edge speech adapter."""
import asyncio
import html
import json
import os
import re
import sys
from pathlib import Path
import edge_tts
from aiohttp.client_exceptions import ClientConnectorError, ClientSSLError, WSServerHandshakeError

MINIMUM_EDGE_TTS_VERSION = (7, 3, 1)
REJECTED_HANDSHAKE_STATUSES = {400, 401, 403, 404, 410, 413, 415, 422, 429}

class EdgeRuntimeVersionError(RuntimeError):
    pass

def assert_runtime():
    version = re.match(r'^(\d+)\.(\d+)\.(\d+)', getattr(edge_tts, '__version__', ''))
    if not version or tuple(map(int, version.groups())) < MINIMUM_EDGE_TTS_VERSION:
        raise EdgeRuntimeVersionError('Edge TTS runtime requires the current handshake protocol')

def report_error(kind, known, status=None):
    # Never include the signed WebSocket URL, request text or local paths.
    print('EDGE_TTS_ERROR:' + json.dumps({'kind': kind, 'providerOutcomeKnown': known, 'status': status}), file=sys.stderr)

async def main():
    assert_runtime()
    if sys.argv[1:] == ['check']:
        return
    request = json.loads(Path(sys.argv[1]).read_text())
    output = Path(sys.argv[2])
    voice = request['voice'] or 'zh-CN-XiaoxiaoNeural'
    if voice not in ('zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural'):
        raise ValueError('Unsupported voice')
    words = []
    rate = f"{round((request['speed'] - 1) * 100):+d}%"
    with output.open('wb') as audio:
        for attempt in range(2):
            try:
                stream = edge_tts.Communicate(
                    request['text'], voice=voice, rate=rate, boundary='WordBoundary',
                    proxy=os.environ.get('MODEL_DOCK_EDGE_PROXY') or None,
                ).stream()
                async for item in stream:
                    if item['type'] == 'audio':
                        audio.write(item['data'])
                    elif item['type'] == 'WordBoundary':
                        words.append({'text': html.unescape(item['text']), 'startSeconds': item['offset'] / 10000000,
                                      'endSeconds': (item['offset'] + item['duration']) / 10000000})
                break
            except ClientConnectorError as error:
                # A failed connection has not sent speech. After any response
                # data, the stream may have completed an earlier chunk.
                retryable = not (audio.tell() or words or isinstance(error, ClientSSLError))
                if attempt or not retryable:
                    report_error('connection-failed', retryable)
                    raise SystemExit(1) from None
                await asyncio.sleep(0.5)
    Path(sys.argv[3]).write_text(json.dumps({'words': words, 'voice': voice}, ensure_ascii=False))

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except EdgeRuntimeVersionError:
        report_error('runtime-outdated', True)
        sys.exit(1)
    except WSServerHandshakeError as error:
        output = Path(sys.argv[2]) if len(sys.argv) > 2 else None
        # A later chunk can fail after audio was received. Its outcome remains
        # uncertain; only an explicit rejection before any audio is known.
        known = error.status in REJECTED_HANDSHAKE_STATUSES and output is not None and output.exists() and output.stat().st_size == 0
        report_error('handshake-rejected', known, error.status)
        sys.exit(1)
