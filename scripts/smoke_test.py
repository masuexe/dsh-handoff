#!/usr/bin/env python3
"""Run one real DSH job and one small Codex callback in an isolated workspace."""
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import handoff


def main():
    if sys.argv[1:] != ["--live"]:
        raise SystemExit("Use --live. This test makes a DSH request and a Codex callback.")
    folder = Path(tempfile.mkdtemp(prefix="dsh-handoff-live-"))
    plan = folder / "test-plan.md"
    plan.write_text("""Create hello.txt in the current workspace.
Its content must be HANDOFF_DEEPSEEK_OK followed by a newline.
Read hello.txt to verify the content.
Do not change other workspace files.
Return the JSON result report specified by the handoff worker.
Do not run unrelated checks or contact Codex.
""")
    evidence = {"workspace": str(folder), "started_at": handoff.stamp()}
    with handoff.Codex() as observer:
        result = observer.rpc("thread/start", {
            "cwd": str(folder),
            "developerInstructions": "This thread tests a local background callback. "
            "When a user message starts with [DSH_HANDOFF_RESULT, reply exactly HANDOFF_WAKE_OK. "
            "Do not use tools. The external test program checks the files and report."})
        thread_id = result["thread"]["id"]
        evidence["parent_thread"] = thread_id
        submission = handoff.submit(SimpleNamespace(parent_thread=thread_id, cwd=str(folder), plan=str(plan),
                                                   model="auto/deepseek-v4.1-flash", effort="low",
                                                   timeout=180, hold_notification=False))
        evidence.update(submission)
        print(json.dumps(submission), flush=True)
        job_dir = handoff.job_dir(submission["job_id"])
        job = handoff.read_job(job_dir)
        if job.get("backend") == "web-host":
            for _ in range(30):
                try:
                    live = handoff.host_rpc({"command": "inspect", "id": job["id"]}, job["host_socket"])
                    if live.get("source") == "live" and live.get("agent_status") == "running":
                        break
                    time.sleep(0.2)
                except RuntimeError:
                    time.sleep(0.2)
            else:
                raise RuntimeError("The Web Host did not expose the normal session.")
            assert live["source"] == "live", live
            assert live["agent_status"] == "running", live
            assert live["interrupted"] is False, live
            evidence["web_session_during_execution"] = live
        deadline = time.monotonic() + 240
        answer = ""
        completed = False
        while time.monotonic() < deadline:
            try:
                event = observer.receive(timeout=min(30, max(0.001, deadline - time.monotonic())))
            except TimeoutError:
                job = handoff.read_job(handoff.job_dir(submission["job_id"]))
                if job.get("notification") == "failed":
                    raise RuntimeError(json.dumps(job))
                continue
            params = event.get("params", {})
            if params.get("threadId") != thread_id:
                continue
            if event.get("method") == "item/completed":
                item = params.get("item", {})
                if item.get("type") == "agentMessage":
                    answer = item.get("text", "")
            if event.get("method") == "turn/completed":
                completed = params["turn"]["status"] == "completed"
                break
        assert completed, "The callback did not complete."
        assert answer.strip() == "HANDOFF_WAKE_OK", repr(answer)
        assert (folder / "hello.txt").read_text() == "HANDOFF_DEEPSEEK_OK\n"
        job = handoff.read_job(handoff.job_dir(submission["job_id"]))
        assert job["status"] == "completed", job
        # The model can complete before the worker saves the turn acknowledgement.
        for _ in range(20):
            if job["notification"] == "delivered":
                break
            time.sleep(0.1)
            job = handoff.read_job(handoff.job_dir(submission["job_id"]))
        assert job["notification"] == "delivered", job
        if job.get("backend") == "web-host":
            after = handoff.host_rpc({"command": "inspect", "id": job["id"]}, job["host_socket"])
            assert after["source"] == "live" and after["agent_status"] == "idle", after
            assert after["interrupted"] is False, after
            assert after["default_model"] == evidence["web_session_during_execution"]["default_model"]
            evidence["web_session_after_execution"] = after
            headers = []
            for line in Path(job["dsh_events_path"]).read_text().splitlines():
                event = json.loads(line)
                if event.get("type") == "request/header":
                    headers.append(event["data"]["header"]["config"])
            assert headers, "No durable model request header was recorded."
            assert all(header["model"] == "auto/deepseek-v4.1-flash" and header.get("reasoningEffort") == "low"
                       for header in headers), headers
            evidence["model_request_headers"] = [{k: h.get(k) for k in ["provider", "model", "reasoningEffort"]}
                                                  for h in headers]
        evidence.update(result="passed", callback_answer=answer, job=job, finished_at=handoff.stamp())
        observer.rpc("thread/archive", {"threadId": thread_id})
    output = handoff.ROOT / "out/smoke-result.json"
    output.parent.mkdir(exist_ok=True)
    handoff.write_json(output, evidence)
    print(json.dumps({"result": "passed", "evidence": str(output), "job_id": job["id"]}), flush=True)


if __name__ == "__main__":
    main()
