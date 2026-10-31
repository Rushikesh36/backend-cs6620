# Fingerprints and the scan diff

How the backend decides that a finding in today's scan is "the same bug" as one in an earlier scan, and how it labels each finding NEW, STILL OPEN or FIXED. Code: `common/findings/fingerprint.ts` and `common/findings/diff.ts`. Tests: `tests/fingerprint.test.ts` and `tests/diff.test.ts`.

## Why fingerprints

Scanners report the same bugs on every run. Without a way to recognise them, every scan would look like "50 new problems" and people would stop reading the alerts. A fingerprint is a short ID that stays the same for the same bug across scans, so the backend can say "1 new, 49 still open".

A fingerprint is the sha256 of a few chosen facts about the finding, written as 64 lowercase hex characters (the `fingerprint` in `docs/contract.md`). It is the sort key of the findings table, under `pk = projectId#scanType`.

## What goes into a fingerprint

| Scan | Parts, in order                                                             |
| ---- | --------------------------------------------------------------------------- |
| SAST | project ID, `SAST`, rule ID, file path, matched code                        |
| DAST | project ID, `DAST`, rule ID, HTTP method, URL path, attacked parameter name |

The parts are hashed as a JSON array, for example `["demo","SAST","python.sqli","app/views.py","execute(...)"]`. A plain `a|b|c` join would let `"x|y" + "z"` and `"x" + "y|z"` produce the same text, and so the same fingerprint, because scanner text can contain `|`.

### What is left out, and why

| Left out                | Why                                                                                                                                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SAST line number        | Adding one line at the top of a file would move every bug below it and make them all look new. The line is still shown, in `location`.                                                                                              |
| Whitespace in SAST code | Re-indenting or running a formatter (`f(a,b)` to `f(a, b)`) is not a new bug. All whitespace is removed, not just collapsed, because collapsing runs to one space still differs when a formatter adds a space where there was none. |
| DAST host and port      | Each Learner Lab runs Juice Shop at its own address. The same bug must have the same fingerprint in every lab. The project ID already separates apps.                                                                               |
| DAST query values       | ZAP tries many values (`q=apple`, `q='OR 1=1`) against one parameter. The parameter name is what identifies the bug.                                                                                                                |
| Message and severity    | Scanner versions reword messages and sometimes change severities. The latest text is stored, but changing it does not create a new finding.                                                                                         |

### Small clean-ups before hashing

- File paths use forward slashes and lose a leading `./`, so `./app\views.py` and `app/views.py` match.
- The HTTP method is upper-cased.
- A DAST URL may be a full URL or just a path; only the path counts. A malformed URL does not throw: the scheme, host, query and fragment are stripped by hand, so one bad line in a report cannot fail the whole scan.
- Rows returned by the diff have exactly the contract's fields, even if the stored rows passed in carry extras such as `pk`.

### Known trade-offs

- **Two identical vulnerable lines in one file** (same rule, same code) get one fingerprint and are shown as one finding. Telling them apart would need the line number or a position, which brings back the "everything moved" problem. One finding per distinct piece of code is the better trade for a review tool.
- **Moving a bug to another file**, or renaming the file, gives a new fingerprint: the old one becomes FIXED and the new one NEW. That is honest: the code really moved.
- **Changing the matched code itself** (even fixing a typo in the same line) gives a new fingerprint.
- **Changing these rules later** changes every fingerprint, so every finding would show as FIXED and NEW once. Avoid it after real data exists.

## The diff rules

`diffFindings(previous, current, jobId)` compares the new scan (`current`) with every stored row for the same project and scan type (`previous`, OPEN and FIXED).

| Before     | In this scan | Label      | Row written                                                                              |
| ---------- | ------------ | ---------- | ---------------------------------------------------------------------------------------- |
| never seen | yes          | NEW        | `OPEN`, `firstSeenJobId` = `lastSeenJobId` = this scan                                   |
| `FIXED`    | yes          | NEW        | back to `OPEN`; `firstSeenJobId` unchanged; `lastSeenJobId` = this scan                  |
| `OPEN`     | yes          | STILL OPEN | `OPEN`; `lastSeenJobId` = this scan; rule, severity, location and message from this scan |
| `OPEN`     | no           | FIXED      | `FIXED`; `lastSeenJobId` unchanged (the last scan that saw it)                           |
| `FIXED`    | no           | (none)     | not written, not counted                                                                 |

The summary stored on the job is `{ new, newHigh, stillOpen, fixed }`, where `newHigh` counts NEW findings with severity HIGH. A returning HIGH finding counts in `newHigh`, so it triggers an alert again (Task 24 sends the email when `newHigh >= 1`).

Other rules:

- If one scan reports the same fingerprint twice, the first one is kept and it counts once.
- The function is pure: it does not change its inputs and returns the changes in a fixed order (by fingerprint).

## Notes for the processor (Task 19)

- Query all rows for `pk = projectId#scanType` (follow every page) and pass them as `previous`.
- Write every `row` in `changes`; untouched rows need no write.
- Running the diff a second time for the same job would give a different summary (that job's NEW findings would look STILL OPEN). So the processor must check the job is not already COMPLETED or FAILED before diffing, and finish with the conditional `transitionJob`, which refuses a second final state.
