#!/usr/bin/env node
import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    CallToolResult,
    ListToolsRequestSchema,
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
    sendToolsChanged()
    previousResponse = ""
    throw new Error("No working IDE endpoint found in range 63342-63352");
}

let previousResponse: string | null = null;

function sendToolsChanged() {
    try {
        server.notification({method: "notifications/tools/list_changed"})
    } catch (_) {
    }
}

async function testListTools(endpoint: string): Promise<boolean> {
    try {
        const res = await fetch(`${endpoint}/mcp/list_tools`);

        if (!res.ok) {
            return false;
        }

        const currentResponse = await res.text();
        if (previousResponse !== null && previousResponse !== currentResponse) {
            sendToolsChanged()
        }
        previousResponse = currentResponse;
        return true;
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
            tools: {
                listChanged: true,
            },
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

        const {status, error}: IDEResponse = await response.json();
        const isError = !!error;
        const text = status ?? error;
        return {
            content: [{type: "text", text: text}],
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
    const checkEndpoint = () => findWorkingIDEEndpoint().catch();
    // We need to recheck the IDE endpoint every 10 seconds since IDE might be closed or restarted
    setInterval(checkEndpoint, 10000);
    await checkEndpoint();
    console.error("JetBrains Proxy MCP Server running on stdio");
}

runServer().catch(console.error);