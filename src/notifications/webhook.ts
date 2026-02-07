import https from "https";
import http from "http";

export interface NotificationPayload {
    event: "APPROVAL_REQUIRED" | "POLICY_VIOLATION" | "AGENT_BLOCKED" | "ALERT";
    tool: string;
    reason: string;
    timestamp: string;
    requestId?: string;
    approvalUrl?: string;
    agentName?: string;
}

export class WebhookNotifier {
    private webhookUrl: string | null;
    private slackWebhookUrl: string | null;

    constructor() {
        this.webhookUrl = process.env.WEBHOOK_URL || null;
        this.slackWebhookUrl = process.env.SLACK_WEBHOOK_URL || null;
    }

    async notify(payload: NotificationPayload): Promise<void> {
        const promises: Promise<void>[] = [];

        if (this.webhookUrl) {
            promises.push(this.sendHttpWebhook(payload));
        }

        if (this.slackWebhookUrl) {
            promises.push(this.sendSlackNotification(payload));
        }

        await Promise.allSettled(promises);
    }

    private async sendHttpWebhook(payload: NotificationPayload): Promise<void> {
        if (!this.webhookUrl) return;

        const data = JSON.stringify(payload);
        const url = new URL(this.webhookUrl);

        return new Promise((resolve, reject) => {
            const protocol = url.protocol === "https:" ? https : http;
            const req = protocol.request(
                {
                    hostname: url.hostname,
                    port: url.port,
                    path: url.pathname,
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Content-Length": Buffer.byteLength(data)
                    }
                },
                (res) => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        resolve();
                    } else {
                        reject(new Error(`Webhook failed: ${res.statusCode}`));
                    }
                }
            );

            req.on("error", reject);
            req.write(data);
            req.end();
        });
    }

    private async sendSlackNotification(payload: NotificationPayload): Promise<void> {
        if (!this.slackWebhookUrl) return;

        const emoji = this.getEmoji(payload.event);
        const color = this.getColor(payload.event);

        const slackPayload = {
            attachments: [
                {
                    color,
                    blocks: [
                        {
                            type: "header",
                            text: {
                                type: "plain_text",
                                text: `${emoji} AgentBrake: ${payload.event}`,
                                emoji: true
                            }
                        },
                        {
                            type: "section",
                            fields: [
                                { type: "mrkdwn", text: `*Tool:*\n\`${payload.tool}\`` },
                                { type: "mrkdwn", text: `*Time:*\n${payload.timestamp}` }
                            ]
                        },
                        {
                            type: "section",
                            text: { type: "mrkdwn", text: `*Reason:*\n${payload.reason}` }
                        }
                    ]
                }
            ]
        };

        if (payload.event === "APPROVAL_REQUIRED" && payload.approvalUrl) {
            slackPayload.attachments[0].blocks.push({
                type: "actions",
                elements: [
                    {
                        type: "button",
                        text: { type: "plain_text", text: "Approve", emoji: true },
                        style: "primary",
                        url: `${payload.approvalUrl}?action=approve`
                    },
                    {
                        type: "button",
                        text: { type: "plain_text", text: "Deny", emoji: true },
                        style: "danger",
                        url: `${payload.approvalUrl}?action=deny`
                    }
                ]
            } as any);
        }

        const data = JSON.stringify(slackPayload);
        const url = new URL(this.slackWebhookUrl);

        return new Promise((resolve, reject) => {
            const req = https.request(
                {
                    hostname: url.hostname,
                    path: url.pathname,
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Content-Length": Buffer.byteLength(data)
                    }
                },
                (res) => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        resolve();
                    } else {
                        reject(new Error(`Slack webhook failed: ${res.statusCode}`));
                    }
                }
            );

            req.on("error", reject);
            req.write(data);
            req.end();
        });
    }

    private getEmoji(event: string): string {
        switch (event) {
            case "APPROVAL_REQUIRED": return "⏳";
            case "POLICY_VIOLATION": return "🚫";
            case "AGENT_BLOCKED": return "🛑";
            case "ALERT": return "⚠️";
            default: return "🔔";
        }
    }

    private getColor(event: string): string {
        switch (event) {
            case "APPROVAL_REQUIRED": return "#FFA500";
            case "POLICY_VIOLATION": return "#FF0000";
            case "AGENT_BLOCKED": return "#8B0000";
            case "ALERT": return "#FFD700";
            default: return "#808080";
        }
    }
}
