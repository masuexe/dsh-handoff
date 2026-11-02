#!/usr/bin/env python3
"""Verify two real DSH assignments in one session, without Codex model calls."""
import json
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import handoff


def main():
    resume = sys.argv[1:] == ["--resume-existing"]
    if sys.argv[1:] != ["--live"] and not resume:
        raise SystemExit("Use --live or --resume-existing. This test makes DeepSeek assignments.")
    output = handoff.ROOT / "out/continuation-smoke-result.json"
    evidence = json.loads(output.read_text()) if resume else {
        "workspace": tempfile.mkdtemp(prefix="dsh-reuse-live-"), "started_at": handoff.stamp(), "jobs": []}
    workspace = Path(evidence["workspace"])
    with handoff.Codex() as codex:
        thread = codex.rpc("thread/start", {"cwd": str(workspace)})["thread"]["id"]
        session_id = evidence.get("session_id") if resume else None
        try:
            if resume:
                candidates = handoff.host_rpc({"command": "sessions", "cwd": str(workspace)})
                previous = next(row for row in candidates if row["session_id"] == session_id)
                evidence["before_resume"] = {k: previous.get(k) for k in ["session_id", "live", "title"]}
            for value in ([3] if resume else [1, 2]):
                plan = workspace / f"plan-{value}.md"
                plan.write_text(f"Write counter.txt with exactly {value} followed by a newline. "
                                "Read the file to verify it. Do not change any other workspace file. "
                                "Return the requested JSON report. Do not contact Codex.\n")
                result = handoff.submit(SimpleNamespace(parent_thread=thread, cwd=str(workspace),
                    plan=str(plan), model="auto/deepseek-v4.1-flash", effort="low", timeout=180,
                    hold_notification=True, backend="web-host", host_socket=handoff.HOST_SOCKET,
                    continue_session=session_id))
                print(json.dumps(result), flush=True)
                folder = handoff.job_dir(result["job_id"])
                deadline = time.monotonic() + 200
                while time.monotonic() < deadline:
                    job = handoff.read_job(folder)
                    if job["status"] in handoff.TERMINAL:
                        break
                    time.sleep(0.2)
                assert job["status"] == "completed", job
                assert (workspace / "counter.txt").read_text() == f"{value}\n"
                if session_id is not None:
                    assert job["dsh_session_id"] == session_id
                    assert job["session_mode"] == "continue"
                session_id = job["dsh_session_id"]
                evidence["jobs"].append(job)
                candidates = handoff.host_rpc({"command": "sessions", "cwd": str(workspace)})
                assert len(candidates) == 1, candidates
                assert candidates[0]["session_id"] == session_id and candidates[0]["can_continue"]
                assert candidates[0]["title"] == "Handoff " + evidence["jobs"][0]["id"][:8]
                excerpt = handoff.host_rpc({"command": "session-info", "session_id": session_id, "cwd": str(workspace)})
                assert excerpt["running"] is False and excerpt["recent_messages"]
            events = Path(evidence["jobs"][-1]["dsh_events_path"]).read_text().splitlines()
            turns = [json.loads(line)["data"]["turn"] for line in events if json.loads(line)["type"] == "turn/start"]
            assert turns and turns[0] >= len(evidence["jobs"]), turns
            evidence.update(result="passed", session_id=session_id, continuation_turn=turns[0], finished_at=handoff.stamp())
        finally:
            codex.rpc("thread/archive", {"threadId": thread})
    output.parent.mkdir(exist_ok=True)
    handoff.write_json(output, evidence)
    print(json.dumps({"result": "passed", "evidence": str(output), "session_id": session_id}), flush=True)


if __name__ == "__main__":
    main()
