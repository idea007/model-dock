#!/usr/bin/env python3
"""Authenticated loopback service. Models load and warm up before listening."""

import argparse
import hmac
import json
import os
import select
import socket
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import BoundedSemaphore

from engine import Detector, validate_text

MAX_BODY_BYTES = 512 * 1024


def create_server(address, detector, token, runtime_id=""):
    capacity = BoundedSemaphore(1)
    authorization = ("Bearer " + token).encode("utf-8")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def reply(self, status, data):
            body = json.dumps(data, ensure_ascii=False, allow_nan=False).encode("utf-8")
            try:
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
            except OSError:
                pass

        def disconnected(self):
            try:
                if select.select([self.connection], [], [], 0)[0]:
                    return not self.connection.recv(1, socket.MSG_PEEK)
                return False
            except OSError:
                return True

        def authorized(self):
            presented = self.headers.get("Authorization", "").encode("utf-8")
            return hmac.compare_digest(presented, authorization)

        def do_GET(self):
            if self.path != "/health":
                return self.reply(404, {"code": "NOT_FOUND"})
            if not self.authorized():
                return self.reply(401, {"code": "UNAUTHORIZED"})
            return self.reply(200, {"ready": True, "engine": detector.engine,
                                    "modelRevision": detector.revision,
                                    "runtimeId": runtime_id, "pid": os.getpid()})

        def do_POST(self):
            if self.path != "/v1/detect":
                return self.reply(404, {"code": "NOT_FOUND"})
            if not self.authorized():
                return self.reply(401, {"code": "UNAUTHORIZED"})
            self.connection.settimeout(10)
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length < 1 or length > MAX_BODY_BYTES or self.headers.get("Transfer-Encoding"):
                    return self.reply(413, {"code": "TEXT_DETECTION_INPUT_TOO_LARGE"})
                data = json.loads(self.rfile.read(length))
                if not isinstance(data, dict) or set(data) != {"text", "engine"} or data["engine"] != detector.engine:
                    raise ValueError()
                validate_text(data["text"])
            except (ValueError, UnicodeError, OSError):
                return self.reply(422, {"code": "TEXT_DETECTION_INPUT_INVALID"})
            if not capacity.acquire(blocking=False):
                return self.reply(429, {"code": "TEXT_DETECTION_BUSY"})
            try:
                return self.reply(200, detector.detect(data["text"], self.disconnected))
            except ValueError:
                return self.reply(422, {"code": "TEXT_DETECTION_INPUT_INVALID"})
            except Exception:
                return self.reply(503, {"code": "TEXT_DETECTION_FAILED"})
            finally:
                capacity.release()

    server = ThreadingHTTPServer(address, Handler)
    server.daemon_threads = True
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--port", type=int, default=7746)
    parser.add_argument("--runtime-id", required=True)
    args = parser.parse_args()
    token = Path(args.token_file).read_text().strip()
    if len(token) < 32 or not 1 <= args.port <= 65535:
        raise ValueError("TEXT_DETECTION_CONFIGURATION_INVALID")
    detector = Detector(args.model_dir)
    server = create_server(("127.0.0.1", args.port), detector, token, args.runtime_id)
    print(json.dumps({"service": "text-detection", "ready": True, "engine": detector.engine}), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception:
        print("TEXT_DETECTION_START_FAILED", file=sys.stderr)
        sys.exit(1)
