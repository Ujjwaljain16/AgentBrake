import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
    { name: "demo-tools", version: "1.0.0" },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "calculator",
            description: "A simple calculator",
            inputSchema: {
                type: "object",
                properties: {
                    a: { type: "number" },
                    b: { type: "number" },
                    operation: { type: "string", enum: ["add", "subtract"] }
                },
                required: ["a", "b", "operation"]
            }
        },
        {
            name: "read_file",
            description: "Read a file from the filesystem",
            inputSchema: {
                type: "object",
                properties: {
                    path: { type: "string" }
                },
                required: ["path"]
            }
        },
        {
            name: "dangerous_tool",
            description: "A tool that should be blocked",
            inputSchema: { type: "object", properties: {} }
        }
    ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "calculator") {
        return { content: [{ type: "text", text: "42" }] };
    }

    if (name === "read_file") {
        const filePath = (args as any)?.path || "unknown";
        return { content: [{ type: "text", text: `Read file: ${filePath}` }] };
    }

    if (name === "dangerous_tool") {
        return { content: [{ type: "text", text: "DANGER: This should be blocked!" }] };
    }

    throw new Error(`Tool ${name} not found`);
});

const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);
