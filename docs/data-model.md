# Data model

Three DynamoDB tables, all pay-per-request. Defined in `terraform/dynamodb.tf`.

## users

| Attribute        | Type | Notes                           |
| ---------------- | ---- | ------------------------------- |
| `username` (key) | S    | Primary key                     |
| `passwordHash`   | S    | bcrypt hash, never the password |
| `role`           | S    | `user` or `ci`                  |
| `disabled`       | BOOL | `true` blocks login             |

Query: login does one `GetItem` by `username`.

## jobs

Primary key: `jobId` (S, a random UUID).

| Attribute                                          | Type      | Notes                                                    |
| -------------------------------------------------- | --------- | -------------------------------------------------------- |
| `jobId`, `projectId`, `scanType`, `requestedBy`    | S         |                                                          |
| `targetId`                                         | S or null | DAST only                                                |
| `status`                                           | S         | CREATED, QUEUED, RUNNING, COMPLETED, FAILED              |
| `imageTag`                                         | S or null | Scanner image version, set when RUNNING                  |
| `createdAt`, `queuedAt`, `startedAt`, `finishedAt` | S         | ISO-8601, null until reached                             |
| `summary`                                          | M or null | `{ new, newHigh, stillOpen, fixed }`, set when COMPLETED |
| `error`                                            | S or null | Plain-words reason when FAILED                           |
| `taskArn`                                          | S         | Fargate task, so the reaper can stop it                  |
| `scope`                                            | S         | Always `"ALL"`, the key of the `byCreated` index         |

Indexes (all project every attribute, because items are small):

| Index       | Partition key | Sort key    | Used by                    |
| ----------- | ------------- | ----------- | -------------------------- |
| `byProject` | `projectId`   | `createdAt` | `GET /projects/{id}/scans` |
| `byStatus`  | `status`      | `createdAt` | reaper                     |
| `byCreated` | `scope`       | `createdAt` | `GET /scans`               |

## findings

Primary key: `pk` = `projectId#scanType` (for example `demo#SAST`), sort key `fingerprint`.

| Attribute                         | Type | Notes                                           |
| --------------------------------- | ---- | ----------------------------------------------- |
| `fingerprint`                     | S    | 64-char lowercase hex sha256                    |
| `ruleId`, `location`, `message`   | S    | Scanner text, stored and returned as plain text |
| `severity`                        | S    | HIGH, MEDIUM, LOW, INFO                         |
| `state`                           | S    | OPEN or FIXED                                   |
| `firstSeenJobId`, `lastSeenJobId` | S    |                                                 |

## How each endpoint reads and writes

| Endpoint                      | Operation                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `POST /login`                 | `GetItem` on users                                                                                           |
| `POST /scans`                 | `PutItem` on jobs (condition: the jobId does not exist)                                                      |
| `POST /scans/{id}/start`      | `UpdateItem` CREATED to QUEUED (conditional); a failed condition means 409                                   |
| `GET /scans/{id}`             | `GetItem` on jobs (one cheap key lookup)                                                                     |
| `GET /projects/{id}/scans`    | `Query` `byProject`, `ScanIndexForward=false`, `Limit`, cursor = `LastEvaluatedKey`                          |
| `GET /scans`                  | `Query` `byCreated` with `scope = "ALL"`, newest first, same cursor style                                    |
| `GET /projects/{id}/findings` | `Query` findings with `pk = projectId#scanType` (follows 1 MB pages inside the Lambda)                       |
| processor                     | `Query` findings for the diff, `BatchWrite`/`Update` findings, conditional job update to COMPLETED or FAILED |
| reaper                        | `Query` `byStatus` for QUEUED and RUNNING                                                                    |

A project with no scans returns an empty `Query`, which the API returns as `{ "items": [] }`.

## Size of the findings list

`GET /projects/{id}/findings` returns everything for one project and scan type in one response. Semgrep on a large repository can produce hundreds of findings; ZAP usually produces dozens. Thousands are unlikely. API Gateway and Lambda limit a response to 6 MB, about 20,000 findings of this shape, so it is safe for our use. If it ever grows, the fix is a cursor, which would be a contract change.
