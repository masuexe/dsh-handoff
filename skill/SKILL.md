---
name: dsh-handoff
description: Delegate an agreed plan to background DSH DeepSeek. Select a new or relevant existing session, then return the result to the original Codex thread. Use when the user requests this asynchronous workflow. Do not use for ordinary direct coding tasks.
---

# DSH handoff

Use `dsh-handoff` for the background job.
The default installation places this command in `~/.local/bin`.
The command uses the existing Codex daemon and the configured Magpie provider.
It does not require a separate OpenAI API key.
The default backend submits to the handoff plugin in the existing DSH Web Host.
The task appears as a normal conversation named `Handoff JOB_PREFIX` in that Web UI.

## Submit a plan

1. Clarify material ambiguities with the user.
2. Read the relevant project instructions and source files.
3. Save an independent implementation plan in a local file.
4. Include required behavior, scope, constraints, references, and acceptance tests.
5. Distinguish requirements from implementation suggestions.
6. Select a new or existing DSH session with the procedure below.
7. Run this command from the parent Codex environment:

```bash
dsh-handoff submit \
  --plan /absolute/path/to/plan.md \
  --cwd /absolute/path/to/workspace \
  --new-session
```

The command reads `CODEX_THREAD_ID` for the return address.
Use `--parent-thread UUID` only when that variable is absent or the user specifies another return thread.
The workspace must match the parent thread directory.
The default model is `magpie auto/deepseek-v4.1-flash` with effort `low`.
Preserve an explicit user model or effort with `--model` and `--effort`.
The default task time limit is two hours. Use `--timeout SECONDS` when the task needs another limit.

The worker needs network access and access to the local Codex socket.
If the execution tool restricts these resources, request its normal sandbox escalation for the submit command.
The worker and Web task continue after the shell command exits.
If the Web Host plugin is unavailable, report the connection failure.
Do not silently switch to headless mode.
Use `--backend headless` only when the user requests the independent-process mode.
The Web UI can show a false interruption for an active headless task.

## Select a session

Choose the session yourself unless the user specifies one.
Do not ask the user to approve routine session selection.
List candidates in the exact task workspace:

```bash
dsh-handoff sessions --cwd /absolute/path/to/workspace
```

Prefer an existing session for a repair, review follow-up, or the next part of the same task.
Its history must remain relevant to the new assignment.
Use the returned title, prior job summary, and state to select a candidate.
If necessary, read a bounded excerpt:

```bash
dsh-handoff session-info SESSION_ID --cwd /absolute/path/to/workspace
```

Continue a suitable idle session with `submit --continue-session SESSION_ID` instead of `--new-session`.
The current continuation interface requires the same provider, model, and reasoning effort.
Choose a new session for an independent task, an incompatible model selection, or an excessive or unrelated history.
If no candidate clearly matches, choose a new session.
State the choice and a short reason with the handoff receipt.
Do not queue work into a busy session, change its title, or repeat completed work merely to reconstruct context.
If the user specified an unavailable session, report that failure instead of silently choosing another session.

After a successful submission, report the job ID and end the turn.
Do not poll, sleep, inspect progress logs, or run parallel implementation work.
Do not keep an active autonomous goal that will continue work during the handoff.
If such a goal exists, resolve that conflict before submission under the existing goal rules.
Do not claim that a callback succeeded before the tool records delivery.

## Receive a result

A callback starts with `[DSH_HANDOFF_RESULT UUID]`.
Read the saved plan and result report.
Review the relevant diff and test evidence.
Treat DSH claims as evidence to check, not as proof.
Perform additional checks when the evidence requires them.
Avoid a second full implementation or an unrelated audit.
Deliver the result in the user's language.

If a repair is necessary, submit a focused plan and end the turn again.
After two unsuccessful repair jobs for the same fault, report the blocker to the user.
Do not create an unlimited repair cycle.
Preserve the user's authorization for commits, pushes, publication, and deployment.

## Inspect or recover a job

Use these commands when the user requests status or a callback fails:

```bash
dsh-handoff status JOB_UUID
dsh-handoff notify JOB_UUID
dsh-handoff recover JOB_UUID
```

`notify` retries a callback after a definite failure.
`recover` reconnects to the same Web job without repeating its file changes.
For a headless job, it reports the interruption without another execution.
If delivery status is `sending`, its outcome is unknown.
Inspect the parent thread before any manual replacement notification.
The tool refuses automatic duplicate delivery in that state.
The machine, DSH Web Host, and Codex daemon must remain available for automatic delivery.
