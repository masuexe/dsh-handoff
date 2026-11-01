---
name: dsh-handoff
description: Delegate an agreed implementation plan to background DSH DeepSeek, end the Codex turn, and receive the result in the original thread. Use when the user requests this asynchronous workflow. Do not use for ordinary direct coding tasks.
---

# DSH handoff

Use `dsh-handoff` for the background job.
The default installation places this command in `~/.local/bin`.
The command uses the existing Codex daemon and the configured Magpie provider.
It does not require a separate OpenAI API key.

## Submit a plan

1. Clarify material ambiguities with the user.
2. Read the relevant project instructions and source files.
3. Save an independent implementation plan in a local file.
4. Include required behavior, scope, constraints, references, and acceptance tests.
5. Distinguish requirements from implementation suggestions.
6. Run this command from the parent Codex environment:

```bash
dsh-handoff submit \
  --plan /absolute/path/to/plan.md \
  --cwd /absolute/path/to/workspace
```

The command reads `CODEX_THREAD_ID` for the return address.
Use `--parent-thread UUID` only when that variable is absent or the user specifies another return thread.
The workspace must match the parent thread directory.
The default model is `magpie auto/deepseek-v4.1-flash` with effort `high`.
Preserve an explicit user model or effort with `--model` and `--effort`.
The default task time limit is two hours. Use `--timeout SECONDS` when the task needs another limit.

The worker needs network access and access to the local Codex socket.
If the execution tool restricts these resources, request its normal sandbox escalation for the submit command.
The worker continues after the shell command exits.

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
`recover` reports an interrupted job without repeating its file changes.
If delivery status is `sending`, its outcome is unknown.
Inspect the parent thread before any manual replacement notification.
The tool refuses automatic duplicate delivery in that state.
The local host and Codex daemon must remain available for automatic delivery.
