"""Redact local cache locations from third-party Python output."""

import os
import sys
import tempfile
from pathlib import Path


class PrivatePathOutput:
    def __init__(self, stream, locations):
        self.stream = stream
        self.locations = locations

    def write(self, value):
        for location in self.locations:
            value = value.replace(location, "<local>")
        return self.stream.write(value)

    def __getattr__(self, name):
        return getattr(self.stream, name)


def install_private_output():
    temporary = Path(tempfile.gettempdir())
    locations = [os.environ.get("HF_HOME"), str(Path.home()), str(temporary), str(temporary.resolve())]
    locations = [location for location in locations if location and location not in {"/", "/tmp", "/private/tmp"}]
    sys.stdout = PrivatePathOutput(sys.stdout, locations)
    sys.stderr = PrivatePathOutput(sys.stderr, locations)
