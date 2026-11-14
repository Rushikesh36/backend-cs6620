import { PublishCommand, type SNSClient } from "@aws-sdk/client-sns";
import type { ScanSummary } from "../../common/findings/diff.js";
import type { ScanType } from "../../common/validation.js";

/** What one alert email is about. Counts and IDs only: never code, URLs or anything secret. */
export interface ScanAlert {
  jobId: string;
  projectId: string;
  scanType: ScanType;
  summary: ScanSummary;
}

/** Architecture 5.5: an email only when the scan found at least one new HIGH finding. */
export const shouldAlert = (summary: ScanSummary): boolean => summary.newHigh >= 1;

/** SNS refuses email subjects over 100 characters. */
export const MAX_SUBJECT = 100;

const findings = (n: number): string => `${String(n)} finding${n === 1 ? "" : "s"}`;

export function alertSubject(alert: ScanAlert): string {
  const { newHigh } = alert.summary;
  const subject = `Security Hub: ${String(newHigh)} new HIGH ${newHigh === 1 ? "finding" : "findings"} in ${alert.projectId} (${alert.scanType})`;
  return subject.slice(0, MAX_SUBJECT);
}

export function alertBody(alert: ScanAlert): string {
  const { summary } = alert;
  return [
    `A ${alert.scanType} scan of project "${alert.projectId}" found ${findings(summary.newHigh)} rated HIGH that the last scan did not have.`,
    "",
    `New:        ${findings(summary.new)} (${String(summary.newHigh)} HIGH)`,
    `Still open: ${findings(summary.stillOpen)}`,
    `Fixed:      ${findings(summary.fixed)}`,
    "",
    `Job ID: ${alert.jobId}`,
    "Open the project's findings in the dashboard to see what they are.",
  ].join("\n");
}

/** Publishes one alert to the topic the email subscription listens on (terraform/alerts.tf). */
export function publishAlert(client: SNSClient, topicArn: string) {
  return async (alert: ScanAlert): Promise<void> => {
    await client.send(
      new PublishCommand({
        TopicArn: topicArn,
        Subject: alertSubject(alert),
        Message: alertBody(alert),
      }),
    );
  };
}
