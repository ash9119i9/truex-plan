# Workspace tools: test plan and results

Date: 2026-09-28. Scope: the workspace file tools, `run_script`, the workspace sweeper, code-file downloads, and how they are wired into the business runtime. The SAP MCP tools themselves are out of scope until SAP access is available; the SAP cases below are the plan for that phase.

Design rule for this area: plan for the worst case. Every case asks what happens when the input is huge, hostile, concurrent, or arrives while something else is failing.

## How to run

```sh
cd agent-core
npm test                                   # everything, including real-binary tests
npx tsx --test test/workspace-*.test.ts    # workspace area only
npx tsx --test test/script-runner*.test.ts # script runner only
```

Real-binary tests skip when `vendor/codex/codex-rs/target/debug/codex` is missing. A skipped test does not count as a pass for release.

`agent-core/tsconfig.json` only includes `src/`, so `npm run build` does not type-check tests. Until that is fixed, check tests with a temporary tsconfig that extends it.

## Status legend

| Status | Meaning |
|---|---|
| Automated | Covered by a test that passes in this repo |
| Pending | Test being written or fix awaiting a regression test |
| Needs Docker | Needs a running Docker daemon (unavailable when this was written) |
| Needs SAP | Needs SAP system access and the SAP MCP tools |
| Not started | Identified, not yet covered |

## Test files

| File | Covers |
|---|---|
| `test/workspace-tools.test.ts` | Each workspace tool, limits, path and symlink rules |
| `test/workspace-wiring.test.ts` | Tools offered per thread, routing, tmp/ cleared per turn |
| `test/workspace-e2e.test.ts` | Real Codex binary with a scripted fake model |
| `test/workspace-stress.test.ts` | Scale, concurrency, encoding, path fuzz, planted files |
| `test/script-runner.test.ts` | run_script validation and Docker arguments |
| `test/script-runner-stress.test.ts` | Real-process kills, output caps, argument injection |
| `test/workspace-sweeper.test.ts` | TTL cleanup rules |
| `test/workspace-sweeper-stress.test.ts` | Large trees, permissions, clock skew |
| `test/file-tools.test.ts` | Code-file upload, read and publish |
| `frontend/test/document-kind.test.ts` | Code-file labels in Documents |

## Verified end to end (real Codex binary)

Run against the pinned binary through `BusinessRuntime` and `ThreadManager`, with a scripted fake model. 2 tests, 19 model requests over 2 user turns, about 1.8 s, passed 3 out of 3 runs.

- The model sees the 8 workspace tools as plain functions without a namespace. It never sees `shell`, `shell_command`, `exec_command`, `apply_patch`, `write_stdin` or `local_shell`. It sees `run_script` only when a runner is configured.
- A 3,200-line (149 KB) ABAP report was built with `append_file` across two user turns.
- A read of lines 1499–1501 returned exactly those lines, with `nextOffset` 1502. The tail read reported `truncated: false`.
- `search_files` with glob `*.abap` found the `FORM` at line 2400.
- A one-line `edit_file` succeeded. An ambiguous edit returned "matches 30 times" to the model, and the turn still completed.
- `../../etc/passwd` and absolute paths were refused, and nothing was created outside the workspace.
- `tmp/` was cleared after turn 1. The report file was kept.
- The exported `.abap` in Documents matched the edited file byte for byte.
- No tool output sent to the model contained a server path.

## Measured numbers

Local machine, Node v24.21.0. Script runner numbers use a local process shim in place of Docker, so a real container adds the Docker CLI round-trip on top.

| Measurement | Result |
|---|---|
| Kill latency past a 500 ms timeout (Node `while(true){}`) | 3–6 ms |
| Kill latency past a 500 ms timeout (Python `time.sleep(999)`) | 2–4 ms |
| Script writing 100 MB to stdout and 100 MB to stderr | 64 KB returned per stream, `truncated: true`, RSS grew 34–61 MB |
| 20 script runs in parallel | 130–140 ms total, all correct |
| Sweep of 20,800 entries over 200 workspaces, nothing deleted | 440–470 ms |
| Same sweep, removing 100 workspaces | 750–830 ms |
| End-to-end run through the real Codex binary (19 model requests) | about 1.8 s |
| Build a 1.98 MB file in 23 `append_file` calls | 53 ms |
| Read a 12,000-line file in 777-line pages | 18 ms, every line exactly once |
| Write 2,000 files up to the limit | about 29 s; per write 6 / 14 / 19 / 24 ms at 500 / 1,000 / 1,500 / 2,000 files |
| `list_files` / `search_files` at 2,000 files | 35 ms / 65 ms |
| Slow regexes `(a|a)*b`, `(a|aa)+$` | stopped at the 2 s budget |
| Nested-repeat regexes `(a*)*b`, `(x+x+)+y` | refused before running |
| 200 mixed operations at once on one thread | 61 ms, no lost appends |
| About 1,000 hostile paths × 4 tools | 443 ms, nothing escaped |

## Failure cases found

| # | Severity | Case | Status |
|---|---|---|---|
| F1 | High | A hard link planted inside the workspace to a file outside it let `read_file` and `export_workspace_file` return the outside file's content | Fixed: files with `nlink > 1` are refused and `copy()` skips them. Tested in `workspace-stress.test.ts` |
| F2 | Medium | One folder set to mode 000 by a script made every write fail with a raw `EACCES`, because writes walk the whole tree | Fixed in the walk. Regression test pending. `delete_file` on that folder still needs checking |
| F3 | Medium | Catastrophic regexes such as `(a|a)*b`, `(a|aa)+$`, `(a*)*b` and `(x+x+)+y` block the event loop, which stalls every conversation on the pod | Fixed: search runs in a `vm` context with a 2 s budget per call. Tested in `workspace-stress.test.ts` |
| F4 | Low | A leading BOM was stripped on read, so append and edit silently removed it | Fixed (`ignoreBOM`). Tested in `workspace-stress.test.ts` |
| F5 | Low | A FIFO swapped in after the path check could hang a read | Fixed (`O_NONBLOCK`). Tested in `workspace-stress.test.ts` |
| F6 | Medium | A script child that ignores kill, or a grandchild holding the pipes open, made `run_script` hang forever | Fixed: pipes are destroyed after a grace period and the result is `timedOut: true`. Tested with a real detached grandchild |
| F7 | Low | A synchronous throw from `spawn`, or from the kill command, escaped the error handling | Fixed and tested: spawn failures return 503, kill failures still resolve as timed out |
| F8 | Info | `delete_file` on a symlink used to be refused, so a link planted by a script could only be removed with its parent folder | Changed: it removes the link itself and never the target. Test updated |
| F9 | Low | A symlink swapped in between the script path check and `docker run` | Open, documented by a test. The container resolves the link inside its own filesystem, where only `work/` is mounted and the root is read-only, so it can't reach host files. A host-side check can't close this, because the container resolves the path |
| F10 | Medium | Sweeper: a permission-denied subfolder made that workspace error on every sweep, and its `tmp/` was never cleared | Fixed and tested: a workspace that can't be fully inspected is never deleted, but a readable `tmp/` is still cleared |
| F11 | Medium | Sweeper: a future mtime (clock skew, or a script running `touch -d 2099`) kept a workspace alive forever | Fixed and tested: an mtime more than 60 s ahead uses `min(ctime, now)`, which scripts can't set |
| F12 | Low | Test files are not type-checked by the build | Open. New test files were checked with a temporary tsconfig |
| F16 | Medium | `copy()` only locked the destination thread, so writes or `clearTemp` on the source during a fork crashed the copy with a raw `ENOENT` | Fixed and tested: copy holds both threads' queues in a fixed order (no deadlock on opposite copies) and refuses copying a workspace onto itself |
| F17 | Info | Every write walks the whole workspace to check limits, so writes slow down as it fills: about 6 ms at 500 files, 24 ms at 2,000 | Acceptable at these limits. Revisit if limits grow |
| F13 | Low | An unsafe work root made `run()` throw synchronously instead of rejecting | Fixed and tested |
| F14 | Low | If both `docker kill` calls fail (for example, a hung daemon), the container may keep running with nothing cleaning it up later | Open |
| F15 | Low | Sweeper on a remote filesystem whose clock stays ahead: workspaces never age out. Safe (nothing is deleted) but a disk leak | Open |

## Test catalog

### Workspace file tools

| ID | Case | Expected | Status |
|---|---|---|---|
| WS-01 | Write, append, edit, read, list, search, delete, export on normal files | Each works and returns relative paths | Automated |
| WS-02 | Build a file in many `append_file` calls up to just under 2 MB | Succeeds, content intact | Automated |
| WS-03 | Append that crosses 2 MB | Clean 413, file unchanged | Automated |
| WS-04 | 10,000+ line file read page by page | Every line exactly once, no gaps or repeats at page boundaries | Automated |
| WS-05 | CRLF file, no trailing newline, empty file, only newlines | Line counts and paging correct | Automated |
| WS-06 | 1 MB single-line file in read and search | Output truncated with a marker, no crash | Automated |
| WS-07 | Workspace near 2,000 files and 50 MB | Clean 413 at the limit; time per write measured | Automated |
| WS-08 | `list_files` and `search_files` over 2,000 files | Capped results with `truncated`, time measured | Automated |
| WS-09 | `edit_file` with old string missing, non-unique, or equal to new string | Clear 400 that tells the model what to do | Automated |
| WS-10 | `edit_file` where `new_string` contains `$&`, `$1` | Inserted literally | Automated |
| WS-11 | `delete_file` on the root (`""`, `.`, `a/..`) | Refused | Automated |
| WS-12 | Export name with a folder, a leading dot or control characters | Refused | Automated |
| WS-13 | Export of a file over the conversation file limit (1 MB) | Clean error. Note that workspace files may be up to 2 MB, so a large export can fail | Not started |

### Path security

| ID | Case | Expected | Status |
|---|---|---|---|
| PS-01 | `..`, absolute, `C:/`, UNC, backslash, NUL, control characters | Refused before touching disk | Automated |
| PS-02 | About 1,000 generated malicious paths against write, read, delete and export | Nothing created outside root, no outside content returned | Automated |
| PS-03 | Unicode lookalike dots, full-width dots, trailing slashes, `//`, `./` | Treated as plain names or refused, never an escape | Automated |
| PS-04 | Symlink planted to an outside file or folder, at the leaf or a middle segment | Refused by every tool except delete. Delete removes the link, never the target | Automated |
| PS-05 | Hard link planted to an outside file | Refused by read, append, edit, search and export, skipped by copy | Automated |
| PS-06 | FIFO, socket or device file planted in the workspace | Refused, never hangs | Automated |
| PS-07 | Folder with mode 000 planted | Other operations keep working, clean error on that folder | Automated |
| PS-08 | `work/` itself replaced by a symlink | Refused | Automated |
| PS-09 | `__proto__` and `constructor` as JSON keys and as path segments | Keys rejected; segments are ordinary file names | Automated |

### Concurrency and consistency

| ID | Case | Expected | Status |
|---|---|---|---|
| CC-01 | 50 appends at once on one thread | All land, in order | Automated |
| CC-02 | 200 mixed operations at once on one thread | Consistent final state, no lost writes | Automated |
| CC-03 | 50 threads working at once | Full isolation | Automated |
| CC-04 | Write and delete of the same path at once | One wins cleanly, no partial file | Automated |
| CC-05 | `clearTemp` or `copy` racing writes | No crash, no partial temp files copied | Automated |
| CC-06 | Two agent-core pods serving one thread | Not supported: each pod has its own disk. Needs sticky routing | Not started |

### Encoding

| ID | Case | Expected | Status |
|---|---|---|---|
| EN-01 | Emoji and multibyte text split across append calls | Byte-exact result | Automated |
| EN-02 | Invalid UTF-8 planted on disk | Clean error, no corrupted rewrite | Automated |
| EN-03 | BOM kept through read, append and edit | Kept | Automated |
| EN-04 | NUL in content | Refused | Automated |

### Search safety

| ID | Case | Expected | Status |
|---|---|---|---|
| RX-01 | `(a+)+` style nested repeats | Refused before running | Automated |
| RX-02 | `(a|a)*b`, `(a|aa)+$`, `(a*)*b`, `(x+x+)+y` on crafted input | 400 within about 3 s, other conversations keep running | Automated |
| RX-03 | Normal regex, literal, case-insensitive, glob | Results unchanged by the time budget | Automated |

### Script runner

| ID | Case | Expected | Status |
|---|---|---|---|
| SR-01 | Runner disabled (default) | `run_script` not offered; direct call returns 503 | Automated |
| SR-02 | Exact Docker flags: no network, read-only, no capabilities, non-root, limits | As listed in `script-runner.ts` | Automated |
| SR-03 | Arguments with `; rm -rf /`, `$(id)`, backticks, `--network=host`, `-v /:/host`, `--privileged` | Passed literally after the image name, never as Docker flags | Automated |
| SR-04 | Infinite loop in Node, `sleep` in Python | Killed at the timeout; kill latency measured | Automated (local process shim) |
| SR-05 | Script printing 100 MB | Output capped at 64 KB with `truncated`, memory bounded | Automated (local process shim) |
| SR-06 | Grandchild holding stdout open, child ignoring kill | Returns `timedOut`, never hangs | Automated |
| SR-07 | 20 runs at once | All complete | Automated (local process shim) |
| SR-08 | Timeout 0 or 121, NUL in arguments, unsafe work root | Refused | Automated |
| SR-09 | Real container run with the runner image | Script runs, cannot reach the network, cannot write outside `/work` and `/tmp` | Needs Docker |
| SR-10 | Script fills the disk under `work/` | Should hit a quota. There is no quota today | Needs Docker |
| SR-11 | Script creates a symlink, hard link, FIFO or mode 000 folder | File tools stay safe (PS-04 to PS-07) | Needs Docker |
| SR-12 | Container escape attempts under gVisor or Kata | Contained | Needs Docker |

### Sweeper and cleanup

| ID | Case | Expected | Status |
|---|---|---|---|
| SW-01 | Stale and fresh `tmp/` | Stale cleared, fresh kept | Automated |
| SW-02 | No workspace TTL set | Conversation files never deleted | Automated |
| SW-03 | Symlinked workspace, `work` or `tmp` | Not followed | Automated |
| SW-04 | 20,000 files over 200 workspaces | Sweep time measured, stays bounded | Automated |
| SW-05 | Permission-denied subfolder | Workspace never deleted when it can't be fully inspected; `tmp/` still cleared where possible | Automated |
| SW-06 | Future mtimes | Treated safely, not kept alive forever | Automated |
| SW-07 | Workspace deleted mid-sweep | No crash | Automated |
| SW-08 | `tmp/` cleared on every completed turn, including interrupted and failed turns | Cleared | Automated for completed turns; interrupted and failed not started |

### Runtime wiring and long jobs

| ID | Case | Expected | Status |
|---|---|---|---|
| RT-01 | New thread gets file, workspace and (if enabled) script tools; shell stays off | As expected | Automated |
| RT-02 | Helper agents call a workspace tool | Refused with a message to hand work back to the main agent | Automated (existing helper refusal) |
| RT-03 | Forked conversation | Workspace copied, original unchanged | Not started |
| RT-04 | Context compaction in the middle of a 5,000-line build | Model resumes from the progress file and the workspace, no lost sections | Not started (needs a real model) |
| RT-05 | User interrupts in the middle of an append sequence | File is left at a clean append boundary | Not started |
| RT-06 | agent-core restarts in the middle of a job | Workspace survives on the volume, conversation resumes | Not started |
| RT-07 | Old conversation (created before these tools) | Clear message to start a new conversation | Not started |
| RT-08 | Model output limit hit while writing a large `append_file` call | Tool call fails cleanly; model retries with a smaller chunk | Not started (needs a real model) |

### Downloads and UI

| ID | Case | Expected | Status |
|---|---|---|---|
| UI-01 | `.abap`, `.cds`, `.json`, `.sql` shown with type label and icon | As expected | Automated |
| UI-02 | Download keeps the filename; `.html` downloads, never renders | As expected | Automated (route headers checked by reading code) |
| UI-03 | Upload of code files | Accepted and readable by the model | Automated |
| UI-04 | Browser check of a large exported file | Downloads fully | Not started |

## SAP phase (after access)

These depend on the SAP MCP tools and on a `push_workspace_file` bridge that sends a workspace file to the MCP push tool by path, so the model never re-sends thousands of lines.

| ID | Case | Expected |
|---|---|---|
| SAP-01 | Read metadata for tables, fields and data elements used by a WRICEF report | Results grounded in the system, no invented fields |
| SAP-02 | Generate a 5,000-line report with includes (TOP, SEL, F01, classes) and push each | Every include pushed; totals match the workspace |
| SAP-03 | Push through the bridge versus inline content | Bridge output tokens stay small regardless of file size |
| SAP-04 | Syntax check fails at a line deep in the program | Model fixes it with `edit_file` and re-pushes only that object |
| SAP-05 | Activation fails because a dependent object is inactive | Clear error, model activates in the right order |
| SAP-06 | Object locked by another user in SAP GUI or Eclipse | Clear lock error, no overwrite, user told who holds it if available |
| SAP-07 | Transport missing, released or belonging to another user | Refused with a clear message, no silent assignment |
| SAP-08 | User lacks authorization (for example S_DEVELOP) | SAP's error reaches the user; no retry loop |
| SAP-09 | Network timeout or dropped session during a push | No half-written object; retry is safe |
| SAP-10 | CSRF token or session expiry during a long job | Token refreshed, job continues |
| SAP-11 | Write attempted against a production or non-allowlisted system | Refused before calling SAP |
| SAP-12 | Every write shows a preview or diff and needs approval | Nothing is written without approval; decision is audited |
| SAP-13 | Someone changes the object in SAP between read and push | Detected (compare before write), user asked what to do |
| SAP-14 | Source larger than the ADT or MCP request limit | Clear limit error, split strategy documented |
| SAP-15 | Non-ASCII text, long lines and pretty-printer rules in ABAP source | Round-trips unchanged |
| SAP-16 | Customer namespace and package rules (`Z`/`Y`, `$TMP` versus transportable) | Enforced before push |
| SAP-17 | Unit tests and ATC run after activation | Results reported; failures block "done" |
| SAP-18 | BTP deploy of a multi-file CAP or UI5 project from the workspace | Deploy job runs with approval, logs returned |
| SAP-19 | Rollback: user asks to undo a push | Previous version restored from SAP version history or transport |
| SAP-20 | Final documents (functional spec, technical spec, test evidence) | Generated from the actual pushed code and results |

## Open risks

- Plain Docker shares the host kernel. For multi-tenant use, run scripts under gVisor or a microVM, or in a separate runner service. Never mount the Docker socket into agent-core.
- Scripts can write to `work/` without a disk quota. The file tools cap a workspace at 50 MB, but scripts bypass them.
- The optional Docker script runner requires a separately supplied sandbox image (`SCRIPT_RUNNER_IMAGE`) and a daemon that can access the workspace's absolute host path. Script execution is disabled by default; this repository does not provide a runner image build.
- Workspaces live on each agent-core pod's own volume. More than one replica needs sticky routing per thread, and final deliverables should also go to shared storage.
- Workspace files can be up to 2 MB but conversation files are capped at 1 MB, so exporting a large file can fail (WS-13).
- The regex time budget protects the event loop per call, but many slow searches in a row still cost CPU.
