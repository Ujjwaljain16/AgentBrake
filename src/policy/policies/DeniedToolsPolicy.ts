import { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { AgentRuntimeState, Policy, PolicyResult } from "../types.js";

/** Blocks an explicit list of tool names. Evaluated before the allow-list. */
export class DeniedToolsPolicy implements Policy {
    name = "DeniedToolsPolicy";
    private deniedTools: Set<string>;

    constructor(deniedTools: string[]) {
        this.deniedTools = new Set(deniedTools);
    }

    async validate(request: CallToolRequest, state: AgentRuntimeState): Promise<PolicyResult | null> {
        const toolName = request.params.name;

        if (this.deniedTools.has(toolName)) {
            return {
                policyName: this.name,
                action: "block",
                reason: `Tool '${toolName}' is explicitly denied.`
            };
        }
        return null;
    }
}
