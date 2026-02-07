import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// Create server instance
const server = new Server(
    {
        name: "demo-tools",
        version: "1.0.0",
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
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
                },
            },
            {
                name: "dangerous_tool",
                description: "A tool that should be blocked",
                inputSchema: {
                    type: "object",
                    properties: {}
                }
            }
        ],
    };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "calculator") {
        // Mock result
        return {
            content: [{ type: "text", text: "42" }]
        };
    }

    if (name === "dangerous_tool") {
        return {
            content: [{ type: "text", text: "You should not see this if policy works!" }]
        };
    }

    throw new Error(`Tool ${name} not found`);
});

// Start server
const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);
