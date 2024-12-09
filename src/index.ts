#!/usr/bin/env node
import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    CallToolResult,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

interface IDEResponseOk {
    status: string;
    error: null;
}
interface IDEResponseErr {
    status: null;
    error: string;
}
type IDEResponse = IDEResponseOk | IDEResponseErr;

/**
 * Try to find a working IDE endpoint.
 * Logic:
 * 1. If process.env.IDE_PORT is set, use that port directly.
 * 2. If not set, try ports from 63342 to 63352.
 * 3. For each port, send a test request to /mcp/list_tools. If it works (res.ok), use that port.
 * 4. If no port works, throw an error.
 */
async function findWorkingIDEEndpoint(): Promise<string> {
    // If user specified a port, just use that
    if (process.env.IDE_PORT) {
        const testEndpoint = `http://localhost:${process.env.IDE_PORT}/api`;
        if (await testListTools(testEndpoint)) {
            return testEndpoint;
        } else {
            throw new Error(`Specified IDE_PORT=${process.env.IDE_PORT} but it is not responding correctly.`);
        }
    }

    for (let port = 63342; port <= 63352; port++) {
        const candidateEndpoint = `http://localhost:${port}/api`;
        if (await testListTools(candidateEndpoint)) {
            return candidateEndpoint;
        }
    }

    throw new Error("No working IDE endpoint found in range 63342-63352");
}

async function testListTools(endpoint: string): Promise<boolean> {
    try {
        const res = await fetch(`${endpoint}/mcp/list_tools`);
        return res.ok;
    } catch {
        return false;
    }
}


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

server.setRequestHandler(ListToolsRequestSchema, async () => {
    const endpoint = await findWorkingIDEEndpoint();
    return {
        tools: await fetch(`${endpoint}/mcp/list_tools`)
            .then(res => res.ok ? res.json() : Promise.reject(new Error("Unable to list tools")))
    }
});

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

async function handleToolCall(name: string, args: any): Promise<CallToolResult> {
    try {
        const endPoint = await findWorkingIDEEndpoint();
        const response = await fetch(`${endPoint}/mcp/${name}`, {
            method: 'POST',
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(args)
        });

        if (!response.ok) {
            throw new Error(`Response failed: ${response.status}`);
        }

        const { status, error }: IDEResponse = await response.json();
        const isError = !!error;
        const text = status ?? error;
        return {
            content: [{ type: "text", text: text }],
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
    await findWorkingIDEEndpoint();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("JetBrains Proxy MCP Server running on stdio");
}

runServer().catch(console.error);