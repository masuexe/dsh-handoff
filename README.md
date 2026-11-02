# DSH handoff

DSH handoff submits an agreed implementation plan to the existing DSH Web Host.
DeepSeek implements the plan and tests the changes through the existing Magpie provider.
The worker submits one result message to the original Codex thread after that thread becomes idle.
Codex performs no model calls during the worker's wait.

The tool uses the local Codex daemon through its Unix WebSocket.
It does not start another Codex server or use `codex exec resume`.
It preserves the parent thread's model and execution settings.
Only the callback starts a new Codex turn.
The DSH task appears as an ordinary conversation named `Handoff JOB_PREFIX` in the Web UI.
The same Host owns the task and its UI event stream, so the UI can show its actual progress.

## Requirements

- Linux or WSL with Python 3.10 or later and Node.js 22 or later.
- Codex CLI with its local App Server daemon. Local tests used version 0.166.0.
- A persistent DSH Web Host with the handoff host plugin and a Magpie provider.
- A configured DSH model with the requested reasoning effort.

The Web Host validates the requested model and reasoning effort against its configured provider.
Keep gateway credentials in DSH's existing environment or credential configuration.
Do not add credentials or task logs to this repository.

## Install

Clone this repository into a permanent local directory.
Run the installer from that directory:

```bash
python3 install.py
dsh plugin --profile web add "link:$PWD/host-plugin"
```

The installer creates `.venv` and installs the pinned dependencies.
It uses `uv` when available. Otherwise, it uses Python's `venv` and `pip` modules.
It installs the command in `~/.local/bin` and the skill in `${CODEX_HOME:-$HOME/.codex}/skills/dsh-handoff`.
Add `~/.local/bin` to `PATH` if necessary.
Keep the checkout at its current path because the command refers to its virtual environment.
Restart Codex if the skill does not appear in an existing session.
The plugin must run in the same Web Host as the UI.
If the existing Host does not load the new bundle, restart that Host when it has no active tasks.
Do not install this plugin in a headless profile.

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

The worker saves an independent copy of the plan and submits it through an owner-only local Unix socket.
The plugin creates a normal Agent with a session-local model selection.
It does not change the Web Host's global default model.
The task continues if the submitting shell or the waiting client disconnects.
The external worker owns the callback.

The default socket is `~/.local/state/dsh-handoff/host.sock`.
Set `DSH_HANDOFF_HOST_SOCKET` for both the Host and the command to select another socket.
There is no automatic fallback when the Web Host is unavailable.

Use `--backend headless` to select the original independent-process mode explicitly.
That mode requires DSH on `PATH` and a configured `headless` profile.
It reads plain YAML from `$DSH_HOME/profiles/headless/cordis.patch.yml`, with `~/.dsh` as the default home.
The Web UI can misclassify an active headless session as interrupted because it reads that session as persisted history.

## Results and recovery

Each job stores its state under `~/.local/state/dsh-handoff/jobs/JOB_UUID/`.
The directory contains the plan, result report, final answer, and worker diagnostics.
Web Host task events and restart records reside in `host-jobs/JOB_UUID` beside `jobs`.
Headless jobs retain their events in their own job directory.
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
The Web Host applies the standard Agent preset and its normal tool permissions.
Use the usual sandbox escalation when the launcher needs the local socket or network.

The machine and Web Host must remain on. This version does not install an operating system service.
After a worker interruption, `recover` reconnects to the same Web job without repeating it.
After a Web Host restart, the plugin marks its unfinished jobs interrupted.
Use `recover` to collect that outcome and notify Codex.
An active Codex goal can start extra turns independently. Resolve it before this workflow starts.

## Validation

```bash
.venv/bin/python -m unittest discover -s tests -v
node --test host-plugin/test/host.test.js
```

Use `--hold-notification` for an execution test that must not start a Codex turn.
Use `DSH_HANDOFF_HOME` to select a separate job directory for tests.
