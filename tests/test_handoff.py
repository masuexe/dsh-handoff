import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import subprocess
import unittest
from unittest.mock import patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import handoff
from websockets.sync.server import unix_serve


class HandoffTests(unittest.TestCase):
    def test_terminal_report_accepts_preamble_but_not_incomplete_json(self):
        self.assertEqual(handoff.parse_report('Verification complete.\n{"status":"completed","tests":[]}')["status"], "completed")
        self.assertEqual(handoff.parse_report('```json\n{"status":"blocked"}\n```')["status"], "blocked")
        with self.assertRaises(ValueError):
            handoff.parse_report('Text\n{"status":"completed"')
        with self.assertRaises(ValueError):
            handoff.parse_report('{"status":"completed"} additional prose')

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state_patch = patch.object(handoff, "STATE", self.root / "state")
        self.state_patch.start()
        self.addCleanup(self.state_patch.stop)
        self.job_id = str(uuid.uuid4())
        self.parent = str(uuid.uuid4())
        self.folder = handoff.job_dir(self.job_id)
        self.folder.mkdir(parents=True)
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        (self.folder / "plan.md").write_text("Create one greeting file.")
        handoff.write_json(self.folder / "job.json", {
            "id": self.job_id, "parent_thread": self.parent, "cwd": str(self.workspace),
            "status": "queued", "notification": "pending", "timeout_seconds": 5,
            "notify_timeout_seconds": 5, "hold_notification": False})

    def fake_dsh(self, body):
        script = self.root / "fake-dsh"
        script.write_text(f"#!{sys.executable}\n" + body)
        script.chmod(0o700)
        handoff.update(self.folder, dsh_bin=str(script))
        (self.folder / "overlay.yml").write_text("[]")

    def server(self, handler):
        sock = self.root / "rpc.sock"
        server = unix_serve(handler, path=str(sock))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.shutdown)
        patcher = patch.object(handoff, "SOCKET", sock)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_execute_files_and_structured_report(self):
        self.fake_dsh("""import sys,json
from pathlib import Path
sys.stdin.read()
Path('hello.txt').write_text('hello')
print(json.dumps({'type':'final','text':json.dumps({'status':'completed','summary':'Created hello.txt','tests':[]})}))
""")
        job = handoff.execute(self.folder)
        self.assertEqual(job["status"], "completed")
        self.assertEqual((self.workspace / "hello.txt").read_text(), "hello")
        self.assertEqual(json.loads((self.folder / "answer.txt").read_text())["status"], "completed")

    def test_zero_exit_without_report_is_failure(self):
        self.fake_dsh("import json\nprint(json.dumps({'type':'final','text':'unverified'}))\n")
        self.assertEqual(handoff.execute(self.folder)["status"], "failed")

    def test_nonzero_exit_overrides_success_claim(self):
        self.fake_dsh("import json\nprint(json.dumps({'type':'final','text':json.dumps({'status':'completed'})}))\nraise SystemExit(3)\n")
        self.assertEqual(handoff.execute(self.folder)["status"], "failed")
        self.assertEqual(json.loads((self.folder / "result.json").read_text())["status"], "failed")

    def test_worker_survives_launcher_exit(self):
        self.fake_dsh("import sys,json,time\nsys.stdin.read()\ntime.sleep(0.15)\nprint(json.dumps({'type':'final','text':json.dumps({'status':'completed'})}))\n")
        handoff.update(self.folder, hold_notification=True)
        env = os.environ.copy()
        env["DSH_HANDOFF_HOME"] = str(handoff.STATE)
        code = f"import sys; sys.path.insert(0, {str(handoff.ROOT)!r}); import handoff; handoff.launch(handoff.job_dir({self.job_id!r}))"
        subprocess.run([sys.executable, "-c", code], env=env, check=True, timeout=5)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if handoff.read_job(self.folder)["status"] == "completed":
                break
            time.sleep(0.05)
        self.assertEqual(handoff.read_job(self.folder)["status"], "completed")

    def test_timeout_stops_process(self):
        self.fake_dsh("import time\ntime.sleep(30)\n")
        handoff.update(self.folder, timeout_seconds=0.1)
        started = time.monotonic()
        self.assertEqual(handoff.execute(self.folder)["status"], "failed")
        self.assertLess(time.monotonic() - started, 5)

    def test_blocked_is_not_reported_as_completed(self):
        self.fake_dsh(f"""import sys,json
from pathlib import Path
sys.stdin.read()
print(json.dumps({{'type':'final','text':json.dumps({{'status':'blocked','unresolved':['Need a decision']}})}}))
""")
        self.assertEqual(handoff.execute(self.folder)["status"], "blocked")

    def test_notification_waits_for_idle_and_delivers_once(self):
        started_turns = []
        def handler(ws):
            for raw in ws:
                message = json.loads(raw)
                method = message.get("method")
                if method == "initialized":
                    continue
                if method == "initialize":
                    result = {}
                elif method in {"thread/read", "thread/resume"}:
                    result = {"thread": {"id": self.parent, "status": {"type": "active"}}}
                elif method == "turn/start":
                    started_turns.append(message["params"])
                    result = {"turn": {"id": "test-turn"}}
                else:
                    raise AssertionError(method)
                ws.send(json.dumps({"id": message["id"], "result": result}))
                if method == "thread/resume":
                    self.assertEqual(started_turns, [])
                    ws.send(json.dumps({"method": "thread/status/changed", "params": {
                        "threadId": self.parent, "status": {"type": "idle"}}}))
        self.server(handler)
        handoff.update(self.folder, status="completed")
        self.assertEqual(handoff.notify(self.folder)["notification"], "delivered")
        handoff.notify(self.folder)
        self.assertEqual(len(started_turns), 1)
        self.assertEqual(started_turns[0]["threadId"], self.parent)
        self.assertIn(self.job_id, started_turns[0]["input"][0]["text"])

    def test_lost_acknowledgement_does_not_repeat_callback(self):
        accepted = []
        def handler(ws):
            for raw in ws:
                message = json.loads(raw)
                method = message.get("method")
                if method == "initialized":
                    continue
                if method == "turn/start":
                    accepted.append(message)
                    ws.close()
                    return
                result = {} if method == "initialize" else {"thread": {"status": {"type": "idle"}}}
                ws.send(json.dumps({"id": message["id"], "result": result}))
        self.server(handler)
        handoff.update(self.folder, status="completed")
        with self.assertRaises(Exception):
            handoff.notify(self.folder)
        self.assertEqual(handoff.read_job(self.folder)["notification"], "sending")
        with self.assertRaisesRegex(RuntimeError, "unknown outcome"):
            handoff.notify(self.folder)
        self.assertEqual(len(accepted), 1)

    def test_workspace_collision_does_not_run_dsh(self):
        import hashlib
        key = hashlib.sha256(str(self.workspace).encode()).hexdigest()
        handoff.update(self.folder, hold_notification=True)
        with handoff.lock(handoff.STATE / "workspace-locks" / (key + ".lock")):
            handoff.worker(self.folder)
        self.assertEqual(handoff.read_job(self.folder)["status"], "blocked")
        self.assertFalse((self.folder / "dsh.ndjson").exists())

    def test_recovery_does_not_repeat_execution(self):
        handoff.update(self.folder, status="running", dsh_pid=None)
        with patch.object(handoff, "launch", return_value=123) as launch:
            handoff.recover(self.folder)
        self.assertEqual(handoff.read_job(self.folder)["status"], "interrupted")
        launch.assert_called_once_with(self.folder, notify_only=True)

    def test_worker_refuses_duplicate_execution(self):
        handoff.update(self.folder, status="completed")
        with self.assertRaisesRegex(RuntimeError, "Refuse to repeat"):
            handoff.worker(self.folder)

    def test_web_execution_keeps_the_normal_session_identity(self):
        handoff.update(self.folder, backend="web-host", host_socket="/unused/socket",
                       model="auto/deepseek-v4.1-flash", effort="low")
        receipt = {"session_id": "session-test", "created_at": "now"}
        outcome = {**receipt, "status": "completed", "finished_at": "later", "text": "{}",
                   "report": {"status": "completed", "summary": "done"}, "events_path": "/events"}
        with patch.object(handoff, "host_rpc", side_effect=[receipt, outcome]) as rpc:
            job = handoff.execute(self.folder)
        self.assertEqual(job["status"], "completed")
        self.assertEqual(job["dsh_session_id"], "session-test")
        self.assertEqual(rpc.call_args_list[0].args[0]["command"], "submit")
        self.assertEqual(rpc.call_args_list[1].args[0]["command"], "wait")

    def test_web_execution_forwards_an_explicit_continuation(self):
        handoff.update(self.folder, backend="web-host", host_socket="/unused/socket",
                       model="auto/deepseek-v4.1-flash", effort="low", continue_session="session-previous")
        receipt = {"session_id": "session-previous", "session_mode": "continue", "created_at": "now"}
        outcome = {**receipt, "status": "completed", "finished_at": "later", "text": "{}", "report": {"status": "completed"}}
        with patch.object(handoff, "host_rpc", side_effect=[receipt, outcome]) as rpc:
            job = handoff.execute(self.folder)
        self.assertEqual(job["session_mode"], "continue")
        self.assertEqual(job["dsh_session_id"], "session-previous")
        self.assertEqual(rpc.call_args_list[0].args[0]["session_id"], "session-previous")

    def test_session_listing_does_not_activate_codex(self):
        args = ["dsh-handoff", "sessions", "--cwd", str(self.workspace)]
        with patch.object(sys, "argv", args), patch.object(handoff, "host_rpc", return_value=[]) as rpc, \
                patch.object(handoff, "Codex") as codex, contextlib.redirect_stdout(io.StringIO()):
            handoff.main()
        codex.assert_not_called()
        self.assertEqual(rpc.call_args.args[0]["command"], "sessions")

    def test_new_and_continue_flags_are_mutually_exclusive(self):
        args = ["dsh-handoff", "submit", "--plan", "unused", "--cwd", str(self.workspace),
                "--new-session", "--continue-session", "session-previous"]
        with patch.object(sys, "argv", args), contextlib.redirect_stderr(io.StringIO()), \
                self.assertRaises(SystemExit) as error:
            handoff.main()
        self.assertEqual(error.exception.code, 2)

    def test_web_recovery_reconnects_without_changing_the_prompt(self):
        handoff.update(self.folder, backend="web-host", host_socket="/unused/socket", status="running")
        with patch.object(handoff, "host_rpc", return_value={"status": "running"}), \
                patch.object(handoff, "launch", return_value=123) as launch:
            handoff.recover(self.folder)
        launch.assert_called_once_with(self.folder, resume_web=True)


if __name__ == "__main__":
    unittest.main()
