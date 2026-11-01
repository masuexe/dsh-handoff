#!/usr/bin/env python3
"""Run DSH jobs without a model supervisor and notify the original Codex thread."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
import uuid

import yaml
from websockets.sync.client import unix_connect

ROOT = Path(__file__).resolve().parent
STATE = Path(os.environ.get("DSH_HANDOFF_HOME", str(Path.home() / ".local/state/dsh-handoff")))
CODEX_HOME = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
SOCKET = CODEX_HOME / "app-server-control/app-server-control.sock"
DSH_HOME = Path(os.environ.get("DSH_HOME", str(Path.home() / ".dsh")))
TERMINAL = {"completed", "blocked", "failed", "cancelled", "interrupted"}


def stamp():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def write_json(path, value):
    temp = path.with_name(path.name + ".tmp")
    with temp.open("w") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temp.replace(path)


def job_dir(job_id):
    return STATE / "jobs" / str(uuid.UUID(job_id))


def read_job(folder):
    return json.loads((folder / "job.json").read_text())


def update(folder, **fields):
    job = read_job(folder)
    job.update(fields, updated_at=stamp())
    write_json(folder / "job.json", job)
    return job


@contextlib.contextmanager
def lock(path, blocking=True):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        yield


class RpcError(RuntimeError):
    pass


class Codex:
    """Use the existing daemon. Do not start another server or resume via exec."""

    def __enter__(self):
        self.connection = unix_connect(str(SOCKET), uri="ws://localhost/", open_timeout=10,
                                       max_size=32 * 1024 * 1024)
        self.sequence = 0
        try:
            self.rpc("initialize", {"clientInfo": {"name": "dsh-handoff", "version": "0.1.0"},
                                    "capabilities": {"experimentalApi": True}})
            self.connection.send(json.dumps({"method": "initialized"}))
        except BaseException:
            self.connection.close()
            raise
        return self

    def __exit__(self, *args):
        self.connection.close()

    def receive(self, timeout=30):
        return json.loads(self.connection.recv(timeout=timeout))

    def rpc(self, method, params, timeout=30):
        self.sequence += 1
        request_id = self.sequence
        self.connection.send(json.dumps({"id": request_id, "method": method, "params": params}))
        deadline = time.monotonic() + timeout
        while True:
            message = self.receive(max(0.001, deadline - time.monotonic()))
            if message.get("id") != request_id:
                continue
            if "error" in message:
                raise RpcError(json.dumps(message["error"], ensure_ascii=False))
            return message["result"]

    def thread(self, thread_id):
        return self.rpc("thread/read", {"threadId": thread_id, "includeTurns": False})["thread"]

    def wait_idle(self, thread_id, seconds):
        thread = self.thread(thread_id)
        if thread.get("status", {}).get("type") == "idle":
            return
        # Resume subscribes this connection to status events without a model call.
        thread = self.rpc("thread/resume", {"threadId": thread_id, "excludeTurns": True})["thread"]
        deadline = time.monotonic() + seconds
        while thread.get("status", {}).get("type") != "idle":
            if time.monotonic() >= deadline:
                raise TimeoutError("The parent thread did not become idle.")
            try:
                event = self.receive(min(60, max(0.001, deadline - time.monotonic())))
            except TimeoutError:
                thread = self.thread(thread_id)
                continue
            params = event.get("params", {})
            if event.get("method") == "thread/status/changed" and params.get("threadId") == thread_id:
                thread["status"] = params["status"]
            if thread.get("status", {}).get("type") == "systemError":
                raise RuntimeError("The parent thread has a system error.")


def overlay(model, effort):
    # Read only the provider declaration. Do not import the web surface or stored credentials.
    config = yaml.safe_load((DSH_HOME / "profiles/headless/cordis.patch.yml").read_text())
    provider = None
    for entry in config:
        if entry.get("id") == "llm-pi-ai":
            provider = entry.get("config", {}).get("providers", {}).get("magpie")
    if not provider:
        raise RuntimeError("The headless DSH profile has no Magpie provider.")
    configured = next((m for m in provider.get("models", []) if m.get("id") == model), None)
    if not configured or effort not in configured.get("reasoningEfforts", {}):
        raise ValueError("The DSH model or reasoning effort is not configured.")
    return [{"id": "agent-default-model", "config": {
                "provider": "magpie", "model": model, "reasoningEffort": effort}},
            {"id": "agent-preset-registry", "config": {"selectedDefault": "standard"}},
            {"id": "tool-codex-sessions", "disabled": True}]


def execution_prompt(folder):
    return f"""Complete the implementation plan below in the current workspace.
Read the project instructions before you change files.
Verify assumptions against the source code.
Implement the required behavior. Run the required tests. Correct failures within the task scope.
Do not expand the scope or perform unrelated refactors.
The parent Codex agent ended its turn. Do not send it progress messages.
The external handoff worker will notify Codex after this process exits.
Do not call Codex session tools. Do not start another supervisor.
Do not commit, push, publish, or deploy unless the plan explicitly authorizes that action.
If a material ambiguity blocks the task, stop the affected work and report the question.
After two unsuccessful repairs for the same fault, report the evidence and the remaining problem.
Return the final answer as one concise JSON object. Do not use Markdown fences.
Use these fields: status, summary, changed_files, tests, unresolved, plan_deviations.
Use status completed, blocked, or failed. Distinguish passed tests from tests you did not run.
The external worker will save the report. Do not write to the worker's state directory.
Keep complete test logs in the workspace when needed.

Implementation plan:
{(folder / 'plan.md').read_text()}
"""


def final_text(path):
    answer = ""
    with path.open(errors="replace") as stream:
        for line in stream:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if event.get("type") == "final":
                answer = event.get("text", "")
    return answer


def stop_group(process):
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=5)
    except ProcessLookupError:
        pass
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()


def execute(folder):
    job = read_job(folder)
    environment = {k: v for k, v in os.environ.items() if not k.startswith("CODEX_")}
    prompt = execution_prompt(folder)
    (folder / "prompt.txt").write_text(prompt)
    command = [job["dsh_bin"], "--profile", "headless", "--patch", str(folder / "overlay.yml"),
               "--json", "-"]
    with (folder / "dsh.ndjson").open("w") as out, (folder / "dsh.stderr.log").open("w") as err:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=out, stderr=err,
                                   cwd=job["cwd"], env=environment, start_new_session=True)
        update(folder, status="running", dsh_pid=process.pid, started_at=stamp())
        try:
            process.communicate(prompt.encode(), timeout=job["timeout_seconds"])
        except subprocess.TimeoutExpired:
            stop_group(process)
            return update(folder, status="failed", error="DSH exceeded the task time limit.",
                          finished_at=stamp(), exit_code=process.returncode)
        except BaseException:
            stop_group(process)
            raise
    text = final_text(folder / "dsh.ndjson")
    (folder / "answer.txt").write_text(text)
    try:
        report = json.loads(text)
        if not isinstance(report, dict) or report.get("status") not in {"completed", "blocked", "failed"}:
            raise ValueError("Invalid result status.")
    except (OSError, ValueError):
        report = {"status": "failed", "summary": text[:4000],
                  "unresolved": ["DSH did not return a valid JSON result report."]}
    status = report["status"] if process.returncode == 0 else "failed"
    if not text and status == "completed":
        status = "failed"
    report["status"] = status
    if process.returncode != 0:
        report["worker_error"] = f"DSH exited with code {process.returncode}."
    write_json(folder / "result.json", report)
    return update(folder, status=status, exit_code=process.returncode, finished_at=stamp())


def callback_message(folder):
    job = read_job(folder)
    return f"""[DSH_HANDOFF_RESULT {job['id']}]
The background DSH job ended with status {job['status']}.
Worker error: {job.get('error', 'none')}
Workspace: {job['cwd']}
Plan: {folder / 'plan.md'}
Result report: {folder / 'result.json'}
Final DSH answer: {folder / 'answer.txt'}
Full log: {folder / 'dsh.ndjson'}
Read the plan and result report first. Treat worker output as evidence to verify.
Review the relevant diff and required test evidence. Perform additional checks only when the evidence requires them.
Do not repeat the full implementation or read the complete log unless a specific problem requires it.
If the task is complete, deliver the result to the user in the user's language.
If a repair is necessary, submit a focused follow-up with dsh-handoff and end this turn again.
Do not poll the worker. Do not commit, push, publish, or deploy beyond the user's authorization.
"""


def notify(folder):
    job = read_job(folder)
    if job["notification"] == "delivered":
        return job
    if job["notification"] == "sending":
        raise RuntimeError("The previous delivery has an unknown outcome. Inspect the parent thread before another delivery.")
    if job["status"] not in TERMINAL:
        raise RuntimeError("The DSH job has not ended.")
    update(folder, notification="waiting")
    # Serialize notifications for one parent. No model participates in this wait.
    with lock(STATE / "parent-locks" / (job["parent_thread"] + ".lock")):
        with Codex() as codex:
            codex.wait_idle(job["parent_thread"], job["notify_timeout_seconds"])
            update(folder, notification="sending", delivery_started_at=stamp())
            try:
                result = codex.rpc("turn/start", {
                    "threadId": job["parent_thread"],
                    "clientUserMessageId": job["id"],
                    "input": [{"type": "text", "text": callback_message(folder)}]})
            except RpcError as error:
                update(folder, notification="failed", notification_error=str(error))
                raise
            # A lost acknowledgement remains 'sending'. Never retry it automatically.
            return update(folder, notification="delivered", callback_turn=result["turn"]["id"],
                          delivered_at=stamp(), notification_error=None)


def worker(folder, notify_only=False):
    def terminate(signum, frame):
        raise KeyboardInterrupt("The handoff worker received a termination signal.")
    signal.signal(signal.SIGTERM, terminate)
    with lock(folder / "worker.lock", blocking=False):
        update(folder, worker_pid=os.getpid())
        if not notify_only:
            if read_job(folder)["status"] != "queued":
                raise RuntimeError("The job already started. Refuse to repeat its file changes.")
            workspace = read_job(folder)["cwd"]
            key = hashlib.sha256(workspace.encode()).hexdigest()
            try:
                with lock(STATE / "workspace-locks" / (key + ".lock"), blocking=False):
                    execute(folder)
            except BlockingIOError:
                update(folder, status="blocked", error="Another DSH handoff owns this workspace.", finished_at=stamp())
            except BaseException as error:
                update(folder, status="interrupted" if isinstance(error, KeyboardInterrupt) else "failed",
                       error=str(error), finished_at=stamp())
        if read_job(folder).get("hold_notification"):
            return
        if not (folder / "result.json").exists():
            job = read_job(folder)
            write_json(folder / "result.json", {
                "status": job["status"], "summary": job.get("error", "The worker stopped before it saved a report."),
                "changed_files": [], "tests": [], "unresolved": [job.get("error", "Inspect the job logs.")]})
        if not (folder / "answer.txt").exists():
            (folder / "answer.txt").write_text("")
        for delay in [0, 5, 20]:
            if delay:
                time.sleep(delay)
            try:
                notify(folder)
                break
            except Exception as error:
                job = read_job(folder)
                fields = {"notification_error": str(error)}
                if job["notification"] != "sending":
                    fields["notification"] = "failed"
                update(folder, **fields)
                if job["notification"] == "sending":
                    break


def launch(folder, notify_only=False):
    args = [sys.executable, str(Path(__file__).resolve()), "_worker", folder.name]
    if notify_only:
        args.append("--notify-only")
    with (folder / "worker.log").open("a") as log:
        process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                   start_new_session=True, close_fds=True)
    return process.pid


def submit(args):
    parent = str(uuid.UUID(args.parent_thread or os.environ.get("CODEX_THREAD_ID", "")))
    cwd = Path(args.cwd).resolve(strict=True)
    if not cwd.is_dir():
        raise ValueError("The workspace must be a directory.")
    plan = Path(args.plan).read_text()
    if not plan.strip():
        raise ValueError("The implementation plan is empty.")
    patch = overlay(args.model, args.effort)
    dsh_bin = shutil.which("dsh")
    if not dsh_bin:
        raise RuntimeError("The dsh command is not available.")
    with Codex() as codex:
        thread = codex.thread(parent)  # Fail before launch if the target is unavailable.
        if Path(thread["cwd"]).resolve() != cwd:
            raise ValueError("The workspace differs from the parent thread cwd. Use a parent thread for that workspace.")
    job_id = str(uuid.uuid4())
    folder = job_dir(job_id)
    folder.mkdir(parents=True, mode=0o700)
    (folder / "plan.md").write_text(plan)
    (folder / "overlay.yml").write_text(yaml.safe_dump(patch, sort_keys=False))
    write_json(folder / "job.json", {
        "id": job_id, "parent_thread": parent, "cwd": str(cwd), "status": "queued",
        "notification": "pending", "created_at": stamp(), "model": args.model,
        "effort": args.effort, "dsh_bin": dsh_bin, "timeout_seconds": args.timeout,
        "notify_timeout_seconds": 86400, "hold_notification": args.hold_notification})
    pid = launch(folder)
    return {"job_id": job_id, "worker_pid": pid, "directory": str(folder),
            "next_action": "End the Codex turn. The worker will submit the result when the parent is idle."}


def process_alive(pid):
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def recover(folder):
    # Recovery must never repeat file changes after a worker crash.
    with lock(folder / "worker.lock", blocking=False):
        job = read_job(folder)
        if job["status"] not in TERMINAL:
            if process_alive(job.get("dsh_pid")):
                raise RuntimeError("DSH may still be active. Inspect the recorded process before recovery.")
            update(folder, status="interrupted", error="The previous worker stopped before it saved the outcome.",
                   finished_at=stamp())
        job = read_job(folder)
        if job["notification"] in {"sending", "delivered"}:
            raise RuntimeError("The callback already started. Inspect the parent thread before recovery.")
    return {"job_id": folder.name, "worker_pid": launch(folder, notify_only=True)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    start = commands.add_parser("submit", help="Start a background DSH job and return immediately.")
    start.add_argument("--plan", required=True)
    start.add_argument("--cwd", required=True)
    start.add_argument("--parent-thread")
    start.add_argument("--model", default="auto/deepseek-v4.1-flash")
    start.add_argument("--effort", default="high", choices=["off", "low", "medium", "high", "max"])
    start.add_argument("--timeout", type=int, default=7200)
    start.add_argument("--hold-notification", action="store_true", help="Run DSH but retain the result without a callback.")
    for name in ["status", "notify", "recover"]:
        commands.add_parser(name).add_argument("job_id")
    commands.add_parser("list")
    commands.add_parser("probe").add_argument("--parent-thread", default=os.environ.get("CODEX_THREAD_ID"))
    internal = commands.add_parser("_worker", help=argparse.SUPPRESS)
    internal.add_argument("job_id")
    internal.add_argument("--notify-only", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    if args.command == "submit":
        if args.timeout < 1:
            raise ValueError("The task time limit must be positive.")
        result = submit(args)
    elif args.command == "status":
        result = read_job(job_dir(args.job_id))
        result["worker_visible_in_this_process_namespace"] = process_alive(result.get("worker_pid"))
    elif args.command == "list":
        result = [read_job(p.parent) for p in sorted((STATE / "jobs").glob("*/job.json"))]
    elif args.command == "probe":
        with Codex() as codex:
            thread = codex.thread(str(uuid.UUID(args.parent_thread)))
            result = {key: thread.get(key) for key in ["id", "status", "cwd", "name"]}
    elif args.command == "notify":
        folder = job_dir(args.job_id)
        job = read_job(folder)
        if job["notification"] in {"sending", "delivered"}:
            raise RuntimeError("The callback already started. Refuse a duplicate delivery.")
        if job["status"] not in TERMINAL:
            raise RuntimeError("The DSH job has not ended.")
        result = {"worker_pid": launch(folder, notify_only=True), "job_id": folder.name}
    elif args.command == "recover":
        result = recover(job_dir(args.job_id))
    else:
        worker(job_dir(args.job_id), args.notify_only)
        return
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        print(f"dsh-handoff: {error}", file=sys.stderr)
        sys.exit(1)
