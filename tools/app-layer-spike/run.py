#!/usr/bin/env python3
"""Build/open a signed synthetic .app and measure App Sandbox restrictions.

No production data or remote network requests. Generated bundles live in a private
temporary directory; app launches only via LaunchServices/open.
"""
import argparse
import ctypes
import contextlib
import errno
import json
import os
import pathlib
import plistlib
import re
import signal
import shutil
import socket
import subprocess
import tempfile
import threading


def command(args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=60)


def stop_exact_fixture(executable):
    found = subprocess.run(["pgrep", "-f", "^" + re.escape(str(executable)) + "$"],
                           capture_output=True, text=True, timeout=5)
    for line in found.stdout.splitlines():
        try:
            os.kill(int(line), signal.SIGTERM)
        except ProcessLookupError:
            pass


def launch_fixture(bundle, executable, output, errors):
    try:
        command(["open", "-W", "-n", "-g", "--stdout", str(output), "--stderr", str(errors), str(bundle)])
    except subprocess.TimeoutExpired:
        # Stop only the exact fixture binary we created before removing its bundle.
        stop_exact_fixture(executable)
        raise RuntimeError("LaunchServices fixture timed out; exact fixture processes terminated")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--signing-identity", default="-")
    parser.add_argument("--socket-exception", action="store_true")
    parser.add_argument("--network-client", action="store_true", help="Unsafe diagnostic profile; never a production configuration")
    parser.add_argument("--app-group", help="Dedicated synthetic group: TEAMID.com.mixlabpro.agent-vitals-spike")
    parser.add_argument("--verify-peer", action="store_true", help="Validate kernel audit token, running signature and launched instance")
    options = parser.parse_args()
    if options.app_group and (options.signing_identity == "-" or not re.fullmatch(r"[A-Z0-9]{10}\.com\.mixlabpro\.agent-vitals-spike", options.app_group)):
        parser.error("App Group probe requires a configured signer and the dedicated synthetic group id")
    if options.verify_peer and (not options.app_group or options.network_client or options.socket_exception):
        parser.error("Peer verification requires the strict signed App Group profile")
    source = pathlib.Path(__file__).with_name("probe.m")
    with contextlib.ExitStack() as cleanup:
        temporary = cleanup.enter_context(tempfile.TemporaryDirectory(prefix="avc2-", dir="/private/tmp"))
        root = pathlib.Path(temporary)
        ipc = root / "ipc"
        ipc.mkdir(mode=0o700)
        socket_path = ipc / "broker.sock"
        forbidden = root / "forbidden" / "authority-fixture.txt"
        forbidden.parent.mkdir(mode=0o700)
        forbidden.write_text("Synthetic forbidden file. No user data.", encoding="utf-8")
        listener = socket.socket(socket.AF_UNIX)
        listener.bind(str(socket_path))
        os.chmod(socket_path, 0o600)
        listener.listen(1)
        listener.settimeout(10)
        network = socket.socket(socket.AF_INET)
        network.bind(("127.0.0.1", 0))
        network.listen(1)
        bundle = root / "AgentCitySpike.app"
        contents = bundle / "Contents"
        executable = contents / "MacOS" / "agent-city-spike"
        resources = contents / "Resources"
        executable.parent.mkdir(parents=True)
        cleanup.callback(stop_exact_fixture, executable)
        resources.mkdir()
        bundle_id = "com.mixlabpro.agent-city-spike." + ("adhoc" if options.signing_identity == "-" else "signed")
        info = {"CFBundleIdentifier": bundle_id,
                "CFBundleName": "Agent City Spike", "CFBundleExecutable": executable.name,
                "CFBundlePackageType": "APPL", "CFBundleVersion": "1",
                "CFBundleShortVersionString": "0.0.1", "LSUIElement": True}
        (contents / "Info.plist").write_bytes(plistlib.dumps(info))
        fixture = {"socket_path": str(socket_path), "forbidden_path": str(forbidden),
                   "tcp_port": network.getsockname()[1]}
        if options.app_group:
            fixture["app_group"] = options.app_group
        (resources / "fixture.json").write_text(json.dumps(fixture), encoding="utf-8")
        entitlements = {"com.apple.security.app-sandbox": True,
                        "com.apple.security.files.user-selected.read-write": True}
        if options.socket_exception:
            entitlements["com.apple.security.temporary-exception.files.absolute-path.read-write"] = [str(ipc) + "/"]
        if options.network_client:
            entitlements["com.apple.security.network.client"] = True
        if options.app_group:
            entitlements["com.apple.security.application-groups"] = [options.app_group]
        entitlement_file = root / "entitlements.plist"
        entitlement_file.write_bytes(plistlib.dumps(entitlements))
        command(["xcrun", "clang", "-fobjc-arc", "-framework", "Cocoa", "-Wall", "-Wextra",
                 str(source), "-o", str(executable)])
        command(["codesign", "--force", "--sign", options.signing_identity, "--timestamp=none",
                 "--options", "runtime", "--entitlements", str(entitlement_file), str(bundle)])
        command(["codesign", "--verify", "--strict", str(bundle)])
        launcher = root / "fixture-launcher"
        checker = root / "fixture-peer-check"
        if options.verify_peer:
            command(["xcrun", "clang", "-fobjc-arc", "-framework", "Cocoa",
                     str(source.with_name("launch.m")), "-o", str(launcher)])
            command(["xcrun", "clang", "-fobjc-arc", "-framework", "Foundation", "-framework", "Security",
                     "-lbsm", str(source.with_name("peer_check.m")), "-o", str(checker)])
        if options.app_group:
            preflight_output = root / "preflight.stdout"
            launch_fixture(bundle, executable, preflight_output, root / "preflight.stderr")
            preflight = json.loads(preflight_output.read_text().strip().splitlines()[-1])
            group_path = pathlib.Path(preflight["group_path"])
            if not preflight["group_path"] or group_path.name != options.app_group:
                raise RuntimeError("OS did not return the dedicated synthetic group container")
            ipc = pathlib.Path(cleanup.enter_context(tempfile.TemporaryDirectory(prefix="", dir=str(group_path))))
            listener.close()
            socket_path = ipc / "s"
            listener = socket.socket(socket.AF_UNIX)
            listener.bind(str(socket_path))
            os.chmod(socket_path, 0o600)
            listener.listen(1)
            listener.settimeout(10)
            fixture["socket_path"] = str(socket_path)
            (resources / "fixture.json").write_text(json.dumps(fixture), encoding="utf-8")
            command(["codesign", "--force", "--sign", options.signing_identity, "--timestamp=none",
                     "--options", "runtime", "--entitlements", str(entitlement_file), str(bundle)])
            command(["codesign", "--verify", "--strict", str(bundle)])
        peer = {"observed": False}
        pinned_hash = None
        if options.verify_peer:
            displayed = command(["codesign", "--display", "--verbose=4", str(bundle)])
            match = re.search(r"^CDHash=([0-9a-f]{40}|[0-9a-f]{64})$", displayed.stderr, re.MULTILINE)
            if not match:
                raise RuntimeError("No pre-launch code digest")
            pinned_hash = match.group(1)
        launch_state = {}
        launched = threading.Event()
        response = {}

        def identity(connection, pid, birth=None, expected_bundle=None):
            birth = launch_state if birth is None else birth
            checked = subprocess.run([str(checker), str(connection.fileno()), str(pid), str(expected_bundle or bundle),
                                      options.app_group.split(".")[0], options.app_group,
                                      str(birth["birth_seconds"]), str(birth["birth_microseconds"]), pinned_hash],
                                     pass_fds=(connection.fileno(),), capture_output=True, text=True, check=True, timeout=8)
            return json.loads(checked.stdout)

        def accept():
            try:
                connection, _ = listener.accept()
                with connection:
                    peer["observed"] = True
                    # Darwin kernel peer credential, not a self-reported client PID.
                    peer["kernel_pid"] = int.from_bytes(connection.getsockopt(0, 2, 4), "little", signed=True)
                    uid, gid = ctypes.c_uint(), ctypes.c_uint()
                    status = ctypes.CDLL(None).getpeereid(connection.fileno(), ctypes.byref(uid), ctypes.byref(gid))
                    peer["uid_matches"] = status == 0 and uid.value == os.getuid()
                    if options.verify_peer:
                        if not launched.wait(timeout=8):
                            raise RuntimeError("No authoritative launch instance")
                        peer["identity"] = identity(connection, launch_state["pid"])
                        peer["wrong_instance"] = identity(connection, launch_state["pid"] + 1)
                        peer["wrong_incarnation"] = identity(connection, launch_state["pid"],
                            {**launch_state, "birth_seconds": launch_state["birth_seconds"] + 1})
                        if not peer["identity"]["allowed"]:
                            return
                        changed = root / "ChangedRevision.app"
                        shutil.copytree(bundle, changed)
                        changed_info = plistlib.loads((changed / "Contents/Info.plist").read_bytes())
                        changed_info["CFBundleVersion"] = "2"
                        (changed / "Contents/Info.plist").write_bytes(plistlib.dumps(changed_info))
                        command(["codesign", "--force", "--sign", options.signing_identity, "--timestamp=none",
                                 "--options", "runtime", "--entitlements", str(entitlement_file), str(changed)])
                        peer["wrong_revision"] = identity(connection, launch_state["pid"], expected_bundle=changed)
                        saved = (resources / "fixture.json").read_bytes()
                        try:
                            (resources / "fixture.json").write_text("{}", encoding="utf-8")
                            peer["tampered_resources"] = identity(connection, launch_state["pid"])
                        finally:
                            (resources / "fixture.json").write_bytes(saved)
                    connection.sendall(b"F")
                    if options.verify_peer:
                        connection.settimeout(8)
                        chunks = bytearray()
                        while len(chunks) < 4096:
                            chunk = connection.recv(4096 - len(chunks))
                            if not chunk:
                                break
                            chunks.extend(chunk)
                        response.update(json.loads(chunks))
            except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
                peer["accept_errno"] = getattr(error, "errno", None)
                peer["verification_failed"] = True

        thread = threading.Thread(target=accept, daemon=True)
        thread.start()
        output = root / "stdout"
        errors = root / "stderr"
        if options.verify_peer:
            launch_state.update(json.loads(command([str(launcher), str(bundle)]).stdout))
            if not launch_state["launched"] or not launch_state["exact_bundle"] or launch_state["pid"] <= 0:
                raise AssertionError("No exact LaunchServices instance")
            launched.set()
        else:
            launch_fixture(bundle, executable, output, errors)
        thread.join(timeout=11)
        if thread.is_alive():
            raise RuntimeError("Fixture peer thread did not complete")
        if options.verify_peer:
            # A same-UID client lies about the application id/PID in its bytes.
            # Those bytes are deliberately not read to establish its identity.
            fake = socket.socket(socket.AF_UNIX)
            fake.connect(str(socket_path))
            impostor, _ = listener.accept()
            with fake, impostor:
                fake.sendall(json.dumps({"app_id": bundle_id, "pid": launch_state["pid"]}).encode())
                peer["impostor"] = identity(impostor, launch_state["pid"])
                own_birth = json.loads(command([str(launcher), "--birth", str(os.getpid())]).stdout)
                peer["wrong_code"] = identity(impostor, os.getpid(), own_birth)
        listener.close()
        network.close()
        text = output.read_text(encoding="utf-8") if output.exists() else ""
        if not options.verify_peer and not text.strip():
            raise RuntimeError("Bundle produced no result: " + (errors.read_text() if errors.exists() else "no stderr"))
        result = response if options.verify_peer else json.loads(text.strip().splitlines()[-1])
        result["group_resolved"] = bool(result.pop("group_path"))
        result["app_group"] = bool(options.app_group)
        result["socket_exception"] = options.socket_exception
        result["network_client"] = options.network_client
        result["signed_kind"] = "adhoc" if options.signing_identity == "-" else "configured_identity"
        result["peer"] = peer
        result["synthetic_only"] = True
        if result["forbidden_read"] or result["file_errno"] not in (errno.EPERM, errno.EACCES) or not result["private_write"]:
            raise AssertionError("Synthetic filesystem boundary failed")
        if bool(result["tcp_connected"]) != options.network_client:
            raise AssertionError("TCP sandbox/control observation mismatch")
        if not options.network_client and result["tcp_errno"] not in (errno.EPERM, errno.EACCES):
            raise AssertionError("TCP denial was not an OS permission error")
        if bool(result["unix_connected"]) != bool(options.app_group):
            raise AssertionError("Unix socket feasibility observation mismatch")
        if options.app_group and (not peer.get("uid_matches") or not peer.get("kernel_pid", 0) > 0):
            raise AssertionError("No matching kernel peer observation")
        if options.verify_peer:
            if not peer["identity"]["allowed"] or any(peer[name]["allowed"] for name in
                ["wrong_instance", "wrong_incarnation", "wrong_revision", "tampered_resources", "impostor", "wrong_code"]):
                raise AssertionError("Peer authorization positive/negative mismatch")
            result["launch_instance_bound"] = peer["kernel_pid"] == launch_state["pid"]
            if not result["launch_instance_bound"]:
                raise AssertionError("Kernel peer was not the LaunchServices instance")
        print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
