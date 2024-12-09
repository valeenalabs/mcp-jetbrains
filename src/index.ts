#!/usr/bin/env node
import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    CallToolResult,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    ReadResourceRequestSchema, Tool,
} from "@modelcontextprotocol/sdk/types.js";

const PORT = process.env.IDE_PORT || "63343";
const IDE_ENDPOINT = `http://localhost:${PORT}/api`;

const server = new Server(
    {
        name: "jetbrains/proxy",
        version: "0.1.0",
    },
    {
        capabilities: {
            tools: {},
            resources: {},
        },
    },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await fetch(`${IDE_ENDPOINT}/mcp/list_tools`)
        .then(res => res.ok ? res.json() : Promise.reject(new Error("Unable to list tools")))
}));

server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
        resources: [
            {
                uri: "jetbrains://current_file",
                mimeType: "text/plain",
                name: "Current File inside JetBrains IDE",
            },
        ],
    };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri.toString();
    if (uri === "jetbrains://current_file") {
        return {
            contents: [{
                uri,
                mimeType: "text/plain",
                text: "Hello world!",
            }],
        };
    }
    throw new Error("Resource not found");
});


interface IDEResponseOk {
    text: string;
    error: null;
}
interface IDEResponseErr {
    text: null;
    error: string;
}
type IDEResponse = IDEResponseOk | IDEResponseErr;

async function handleToolCall(name: string, args: any): Promise<CallToolResult> {
    try {
        const response = await fetch(`${IDE_ENDPOINT}/mcp/${name}`, {
            method: 'POST',
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(args)
        });

        if (!response.ok) {
            throw new Error(`Response failed: ${response.status}`);
        }

        const { text, error }: IDEResponse = await response.json();
        const isError = !!error;
        const textNN = text ?? error;
        return {
            content: [{ type: "text", text: textNN }],
            isError,
        };
    } catch (error: any) {
        return {
            content: [{
                type: "text",
                text: error instanceof Error ? error.message : "Unknown error",
            }],
            isError: true,
        };
    }
}

server.setRequestHandler(CallToolRequestSchema, async (request) =>
    handleToolCall(request.params.name, request.params.arguments ?? {})
);

async function runServer() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("JetBrains Proxy MCP Server running on stdio");
}

runServer().catch(console.error);