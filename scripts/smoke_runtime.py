#!/usr/bin/env python3
"""Verify that a packaged DeepSeek Harness runtime starts and speaks JSON-RPC."""

from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path


def launch_args(executable: Path) -> list[str]:
    """The release workflow builds a native runtime taking `--profile sdk`; the Python
    launcher used for local builds takes `sdk` as a subcommand instead."""
    return ["sdk"] if executable.name.startswith("dsh-py") else ["--profile", "sdk"]


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: smoke_runtime.py /path/to/dsh[.exe]")
    executable = Path(sys.argv[1]).resolve()
    if not executable.is_file():
        raise SystemExit(f"runtime executable was not found: {executable}")

    data_dir = Path(tempfile.mkdtemp(prefix="dsh-runtime-smoke-"))
    env = {
        **os.environ,
        "DSH_CWD": str(Path.cwd()),
        "DSH_DATA_DIR": str(data_dir),
        "DSH_HOME": str(data_dir),
        "DSH_SESSION_COMPRESSION": "none",
    }
    process = subprocess.Popen(
        [str(executable), *launch_args(executable)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    assert process.stdin is not None and process.stdout is not None and process.stderr is not None
    lines: queue.Queue[str | None] = queue.Queue()

    def read_stdout() -> None:
        for line in process.stdout:
            lines.put(line)
        lines.put(None)

    reader = threading.Thread(target=read_stdout, daemon=True)
    reader.start()
    try:
        process.stdin.write(json.dumps({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"cwd": str(Path.cwd()), "provider": "deepseek-official", "model": "deepseek-v4-flash"},
        }) + "\n")
        process.stdin.flush()
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            try:
                line = lines.get(timeout=0.5)
            except queue.Empty:
                if process.poll() is not None:
                    break
                continue
            if line is None:
                break
            response = json.loads(line)
            if response.get("id") != 1:
                continue
            info = response.get("result", {}).get("serverInfo", {})
            if info.get("name") != "deepseek-harness-sdk-runtime" or not isinstance(info.get("version"), str):
                raise RuntimeError(f"invalid initialize response: {response}")
            print(f"runtime smoke test passed: {info['name']}/{info['version']}")
            return 0
        stderr = process.stderr.read().strip()
        raise RuntimeError(f"runtime did not initialize within 45 seconds{': ' + stderr if stderr else ''}")
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
        shutil.rmtree(data_dir, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
