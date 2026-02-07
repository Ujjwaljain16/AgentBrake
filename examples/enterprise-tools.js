"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
/**
 * Realistic MCP Tool Server
 * Simulates a dangerous production environment with file, email, and exec access
 */
const server = new index_js_1.Server({ name: "enterprise-tools", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(types_js_1.ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "read_file",
            description: "Read any file from the filesystem",
            inputSchema: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"]
            }
        },
        {
            name: "write_file",
            description: "Write content to any file",
            inputSchema: {
                type: "object",
                properties: {
                    path: { type: "string" },
                    content: { type: "string" }
                },
                required: ["path", "content"]
            }
        },
        {
            name: "send_email",
            description: "Send email to any recipient",
            inputSchema: {
                type: "object",
                properties: {
                    to: { type: "string" },
                    subject: { type: "string" },
                    body: { type: "string" }
                },
                required: ["to", "subject", "body"]
            }
        },
        {
            name: "execute_shell",
            description: "Execute any shell command",
            inputSchema: {
                type: "object",
                properties: { command: { type: "string" } },
                required: ["command"]
            }
        },
        {
            name: "query_database",
            description: "Execute SQL query on production database",
            inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"]
            }
        },
        {
            name: "search_web",
            description: "Search the web (safe operation)",
            inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"]
            }
        },
        {
            name: "summarize_text",
            description: "Summarize text (safe operation)",
            inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"]
            }
        }
    ]
}));
server.setRequestHandler(types_js_1.CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = args;
    switch (name) {
        case "read_file":
            return { content: [{ type: "text", text: `[FILE CONTENTS] ${a.path}: mock file data...` }] };
        case "write_file":
            return { content: [{ type: "text", text: `[WRITTEN] ${a.path} (${a.content?.length || 0} bytes)` }] };
        case "send_email":
            return { content: [{ type: "text", text: `[EMAIL SENT] To: ${a.to}, Subject: ${a.subject}` }] };
        case "execute_shell":
            return { content: [{ type: "text", text: `[EXECUTED] $ ${a.command}` }] };
        case "query_database":
            return { content: [{ type: "text", text: `[DB QUERY] ${a.query} -> 42 rows affected` }] };
        case "search_web":
            return { content: [{ type: "text", text: `[SEARCH] Results for: ${a.query}` }] };
        case "summarize_text":
            return { content: [{ type: "text", text: `[SUMMARY] ${a.text?.substring(0, 50)}...` }] };
        default:
            throw new Error(`Unknown tool: ${name}`);
    }
});
const transport = new stdio_js_1.StdioServerTransport();
server.connect(transport).catch(console.error);
