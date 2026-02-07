import { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { AgentRuntimeState, Policy, PolicyResult } from "../types.js";

export class AllowedToolsPolicy implements Policy {
    name = "AllowedToolsPolicy";
    private allowedTools: Set<string>;

    constructor(allowedTools: string[]) {
        this.allowedTools = new Set(allowedTools);
    }

    async validate(request: CallToolRequest, state: AgentRuntimeState): Promise<PolicyResult | null> {
        const toolName = request.params.name;

        if (!this.allowedTools.has(toolName)) {
            return {
                policyName: this.name,
                action: "block",
                reason: `Tool '${toolName}' is not in the allowed list: [${Array.from(this.allowedTools).join(", ")}].`
            };
        }
        return null;
    }
}
