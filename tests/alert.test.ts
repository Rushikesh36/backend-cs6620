import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import {
  alertBody,
  alertSubject,
  MAX_SUBJECT,
  publishAlert,
  shouldAlert,
  type ScanAlert,
} from "../lambdas/processor/alert.js";

const JOB = "123e4567-e89b-42d3-a456-426614174001";
const alert = (over: Partial<ScanAlert["summary"]> = {}, projectId = "demo-app"): ScanAlert => ({
  jobId: JOB,
  projectId,
  scanType: "SAST",
  summary: { new: 9, newHigh: 6, stillOpen: 2, fixed: 1, ...over },
});

describe("shouldAlert", () => {
  it("alerts only when at least one new finding is HIGH", () => {
    expect(shouldAlert({ new: 3, newHigh: 1, stillOpen: 0, fixed: 0 })).toBe(true);
    expect(shouldAlert({ new: 3, newHigh: 0, stillOpen: 9, fixed: 2 })).toBe(false);
  });
});

describe("alertSubject", () => {
  it("says how many new HIGH findings, where, and which kind of scan", () => {
    expect(alertSubject(alert())).toBe("Security Hub: 6 new HIGH findings in demo-app (SAST)");
    expect(alertSubject(alert({ newHigh: 1 }))).toBe(
      "Security Hub: 1 new HIGH finding in demo-app (SAST)",
    );
  });

  it("stays within SNS's 100-character limit for the longest project ID", () => {
    const longest = `p${"x".repeat(49)}`;
    expect(alertSubject(alert({ newHigh: 9999 }, longest)).length).toBeLessThanOrEqual(MAX_SUBJECT);
  });
});

describe("alertBody", () => {
  it("lists the counts and the job ID", () => {
    const body = alertBody(alert());
    expect(body).toContain('project "demo-app"');
    expect(body).toContain("New:        9 findings (6 HIGH)");
    expect(body).toContain("Still open: 2 findings");
    expect(body).toContain("Fixed:      1 finding");
    expect(body).toContain(`Job ID: ${JOB}`);
  });

  it("holds no links or code, only counts and IDs", () => {
    expect(alertBody(alert())).not.toMatch(/https?:\/\//);
  });
});

describe("publishAlert", () => {
  const sns = mockClient(SNSClient);
  beforeEach(() => {
    sns.reset();
  });

  it("publishes the subject and body to the topic", async () => {
    sns.on(PublishCommand).resolves({ MessageId: "m-1" });
    await publishAlert(new SNSClient({}), "arn:aws:sns:us-east-1:123456789012:t")(alert());
    expect(sns.commandCalls(PublishCommand)[0]?.args[0].input).toEqual({
      TopicArn: "arn:aws:sns:us-east-1:123456789012:t",
      Subject: alertSubject(alert()),
      Message: alertBody(alert()),
    });
  });

  it("lets an SNS error through, for the processor to log", async () => {
    sns.on(PublishCommand).rejects(new Error("throttled"));
    await expect(
      publishAlert(new SNSClient({}), "arn:aws:sns:us-east-1:123456789012:t")(alert()),
    ).rejects.toThrow("throttled");
  });
});
