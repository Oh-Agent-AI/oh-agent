#!/usr/bin/env python3
"""Run only the bundled Tauri fixture; localhost/synthetic file, never harness data."""
import argparse
import contextlib
import json
import os
import pathlib
import re
import signal
import socket
import subprocess
import tempfile
import threading


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--signing-identity", default="-")
    options = parser.parse_args()
    repo = pathlib.Path(__file__).resolve().parents[2]
    bundle = repo / "apps/agent-city/native/target/release/bundle/macos/AgentCity.app"
    if not bundle.is_dir():
        parser.error("Build the app bundle first with cargo tauri build --bundles app")
    executable = bundle / "Contents/MacOS/agent-city"
    subprocess.run(["codesign", "--force", "--sign", options.signing_identity, "--timestamp=none", "--options", "runtime",
                    "--entitlements", str(repo / "apps/agent-city/native/Entitlements.plist"), str(bundle)],
                   check=True, capture_output=True, text=True, timeout=30)
    subprocess.run(["codesign", "--verify", "--strict", str(bundle)], check=True, capture_output=True, text=True, timeout=30)
    with contextlib.ExitStack() as cleanup:
        temporary = cleanup.enter_context(tempfile.TemporaryDirectory(prefix="avc2-tauri-", dir="/private/tmp"))
        root = pathlib.Path(temporary)
        forbidden = root / "forbidden.txt"
        forbidden.write_text("Synthetic fixture only.", encoding="utf-8")
        server = cleanup.enter_context(socket.socket())
        server.bind(("127.0.0.1", 0))
        server.listen(8)
        server.settimeout(0.2)
        stop = threading.Event()
        connections = []

        def accept():
            while not stop.is_set():
                try:
                    client, _ = server.accept()
                    connections.append(True)
                    client.close()
                except socket.timeout:
                    pass

        thread = threading.Thread(target=accept, daemon=True)
        thread.start()
        output, errors = root / "stdout", root / "stderr"
        try:
            subprocess.run(["open", "-W", "-n", "-g", "--stdout", str(output), "--stderr", str(errors), str(bundle),
                            "--args", "--fixture-port", str(server.getsockname()[1]),
                            "--fixture-forbidden", str(forbidden)],
                           check=True, capture_output=True, text=True, timeout=45)
        except subprocess.TimeoutExpired:
            found = subprocess.run(["pgrep", "-f", "^" + re.escape(str(executable)) + "($| )"],
                                   capture_output=True, text=True, timeout=5)
            for line in found.stdout.splitlines():
                try:
                    os.kill(int(line), signal.SIGTERM)
                except ProcessLookupError:
                    pass
            output_tail = output.read_text()[-2000:] if output.exists() else ""
            error_tail = errors.read_text()[-2000:] if errors.exists() else ""
            raise RuntimeError("Tauri fixture timed out; exact fixture process terminated; "
                               + repr({"stdout": output_tail, "stderr": error_tail}))
        finally:
            stop.set()
            thread.join(timeout=1)
        lines = output.read_text().splitlines() if output.exists() else []
        reports = [json.loads(line) for line in lines if line.startswith('{"fixture_only":')]
        if len(reports) != 1:
            raise RuntimeError("No unique Tauri fixture report")
        result = reports[0]
        required = ["fixture_only", "ipc_worked", "fetch_blocked", "file_fetch_blocked",
                    "remote_script_blocked", "native_tcp_denied", "native_file_denied"]
        if not all(result[name] is True for name in required) or result["csp_violations"] < 3:
            raise AssertionError("Tauri security boundary failed: " + json.dumps(result))
        if connections:
            raise AssertionError("Fixture loopback server received a forbidden connection")
        result["loopback_connections"] = len(connections)
        print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
