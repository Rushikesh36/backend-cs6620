# Report parsers

How Semgrep (SAST) and ZAP (DAST) reports become findings. Code: `common/findings/semgrep.ts`, `common/findings/zap.ts`, shared pieces in `common/findings/report.ts`. Tests: `tests/semgrep.test.ts`, `tests/zap.test.ts`, and `tests/report-pipeline.test.ts`, which runs real reports through parser, fingerprint and diff. Fingerprint and diff rules: [fingerprints.md](fingerprints.md).

```
scanner report (JSON)  ->  parseSemgrep / parseZap  ->  ParsedFinding[]  ->  toScanned (adds fingerprint)  ->  diffFindings
```

Each parser returns `{ findings, warnings }`. A report that is not the expected shape at all throws `ReportError`. A single broken entry is skipped with a warning, so one odd line never fails the whole scan. Warnings are for the logs, never shown to users.

## Severity mapping

| Semgrep `extra.severity`    | Ours                  |
| --------------------------- | --------------------- |
| `ERROR`, `CRITICAL`, `HIGH` | HIGH                  |
| `WARNING`, `MEDIUM`         | MEDIUM                |
| `INFO`, `LOW`               | LOW                   |
| anything else               | INFO (with a warning) |

`ERROR`, `WARNING` and `INFO` are Semgrep's classic levels; newer versions can also report `CRITICAL`, `HIGH`, `MEDIUM` and `LOW`. Case does not matter.

| ZAP `riskcode` | ZAP name      | Ours                  |
| -------------- | ------------- | --------------------- |
| `3`            | High          | HIGH                  |
| `2`            | Medium        | MEDIUM                |
| `1`            | Low           | LOW                   |
| `0`            | Informational | INFO                  |
| anything else  |               | INFO (with a warning) |

ZAP writes `riskcode` as a string; a number is accepted too.

## Semgrep (`semgrep scan --json`)

| Finding field | From                                                    |
| ------------- | ------------------------------------------------------- |
| rule ID       | `check_id`                                              |
| location      | `path:start.line`, for example `app/views.py:13`        |
| message       | `extra.message` (plain text), or the rule ID if missing |
| fingerprint   | rule ID, `path`, and the matched code (see below)       |

**The matched code.** Free Semgrep (not logged in) writes `"requires login"` in `extra.lines` and `extra.fingerprint` instead of the code. This was confirmed with Semgrep 1.183.0. So the parser takes the code from, in order:

1. `extra.lines`, if it holds real code;
2. `options.readLines(path, start, end)`, which reads those lines from the scanned source;
3. otherwise `line:<n>`, with a warning. Different bugs stay apart, but moving the code will make that finding show as FIXED and NEW once.

**What the scanner wrapper (Task 21) must do:**

- Run Semgrep from inside the extracted source folder (`cd /src && semgrep scan ... .`), so `path` is relative (`app/views.py`), not `/src/app/views.py`.
- Before uploading the report, replace each `extra.lines` that says `requires login` with lines `start.line` to `end.line` of that file. The processor (Task 19) only has the report, not the source, so the code must be in the report.

## ZAP (`zap-*-scan.py -J report.json`)

One finding per alert **instance** (one request that showed the problem):

| Finding field | From                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| rule ID       | `alertRef` (for example `10038-1`, more precise than `pluginid`), else `pluginid`                    |
| location      | `METHOD /path?param`, for example `GET /rest/products/search?q`: the parameter name, never its value |
| message       | `alert`, the plain title. ZAP's `desc` is HTML and is never stored.                                  |
| fingerprint   | rule ID, method, URL path (no host, no query values), parameter name                                 |

**Site-wide alerts.** ZAP marks problems that affect the whole site (a missing security header, a server version banner) as `systemic: true` and lists only a sample of up to 5 pages. The sample changes between runs, which made the same problem look FIXED on one page and NEW on another. A systemic alert therefore becomes **one** finding with location `GET / (site-wide)`.

## Untrusted text

All scanner text is untrusted. The parsers store it as plain text with whitespace collapsed and cap its length so a findings row stays far below DynamoDB's 400 KB item limit: rule ID 300, location 500, message 1,000 characters. Nothing is ever turned into markup.

## Test samples

`tests/fixtures/reports/` holds real, trimmed reports:

- `semgrep-v1.json`, `semgrep-v2.json`: Semgrep 1.183.0 with `--config p/python` on `tests/fixtures/sample-app/v1` and `v2`. Version 2 adds three lines above the SQL bugs, reformats one, replaces MD5 and adds an `eval`.
- `zap-v1.json`, `zap-v2.json`: ZAP 2.17.0 full scan of a small local test site. In version 2 the reflected XSS moves from `/search?q` to `/greet?name`.

`tests/report-pipeline.test.ts` checks the expected result: SAST gives 2 new, 1 new HIGH, 5 still open, 1 fixed; DAST shows only the XSS moving (2 fixed, 2 new).
