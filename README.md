# DSH handoff

DSH handoff runs an agreed implementation plan in a background process.
DeepSeek implements the plan and tests the changes through the existing Magpie provider.
The worker submits one result message to the original Codex thread after that thread becomes idle.
Codex performs no model calls during the worker's wait.

The tool uses the local Codex daemon through its Unix WebSocket.
It does not start another Codex server or use `codex exec resume`.
It preserves the parent thread's model and execution settings.
Only the callback starts a new Codex turn.

## Requirements

- Linux or WSL with Python 3.10 or later.
- Codex CLI with its local App Server daemon. Local tests used version 0.166.0.
- DSH on `PATH`, with a configured `headless` profile and a Magpie provider.
- A configured DSH model with the requested reasoning effort.

The tool reads the Magpie model declaration from `$DSH_HOME/profiles/headless/cordis.patch.yml`.
The default DSH home is `~/.dsh`.
That file must use plain YAML that PyYAML can parse.
Keep gateway credentials in DSH's existing environment or credential configuration.
Do not add credentials or task logs to this repository.

## Install

Clone this repository into a permanent local directory.
Run the installer from that directory:

```bash
python3 install.py
```

The installer creates `.venv` and installs the pinned dependencies.
It uses `uv` when available. Otherwise, it uses Python's `venv` and `pip` modules.
It installs the command in `~/.local/bin` and the skill in `${CODEX_HOME:-$HOME/.codex}/skills/dsh-handoff`.
Add `~/.local/bin` to `PATH` if necessary.
Keep the checkout at its current path because the command refers to its virtual environment.
Restart Codex if the skill does not appear in an existing session.

Use `--bin-dir PATH` or `--codex-home PATH` to select other installation directories.
Use `--skip-deps` to refresh an installation that already has its dependencies.

## Use

```bash
dsh-handoff probe
dsh-handoff submit --plan /absolute/plan.md --cwd /absolute/workspace
```

After submission, end the Codex turn.
The default DSH model is `auto/deepseek-v4.1-flash` with effort `low`.
Use `--effort high` when the task requires more reasoning.
The workspace must match the parent Codex thread directory.
The command reads the parent ID from `CODEX_THREAD_ID`.
Use `--parent-thread UUID` to specify it explicitly.

The worker uses the existing DSH headless profile and credentials.
It saves an immutable copy of the plan and a model selection overlay.
It disables DSH's Codex session tools for this job.
The external worker owns the callback.

## Results and recovery

Each job stores its state under `~/.local/state/dsh-handoff/jobs/JOB_UUID/`.
The directory contains the plan, result report, final answer, DSH events, and diagnostic logs.
Job state and notification state are separate.
A delivered notification means Codex accepted a new turn. It does not mean the review succeeded.

```bash
dsh-handoff list
dsh-handoff status JOB_UUID
dsh-handoff notify JOB_UUID
dsh-handoff recover JOB_UUID
```

The worker retries a notification connection three times before it retains the failure for manual recovery.
It never repeats DSH execution after a failure.
If the server accepted a callback but its acknowledgement was lost, delivery state remains `sending`.
The tool refuses an automatic retry because that retry could create a duplicate turn.
Inspect the original thread for the job marker before further action.

Only one DSH handoff can change a given workspace at a time.
Other editors and agents do not use this tool's workspace lock.
Avoid independent edits in that workspace during a job.
The worker runs with the current account's normal DSH permissions.
Use the usual sandbox escalation when the launcher needs the local socket or network.

The host must remain on. This version does not install an operating system service.
After a host restart, use `recover` to report interrupted work.
An active Codex goal can start extra turns independently. Resolve it before this workflow starts.

## Validation

```bash
.venv/bin/python -m unittest discover -s tests -v
```

Use `--hold-notification` for an execution test that must not start a Codex turn.
Use `DSH_HANDOFF_HOME` to select a separate job directory for tests.
