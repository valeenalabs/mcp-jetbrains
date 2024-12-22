#!/usr/bin/env node
import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    CallToolResult,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Logging is enabled only if LOG_ENABLED environment variable is set to 'true'
const LOG_ENABLED = process.env.LOG_ENABLED === 'true';

export function log(...args: any[]) {
    if (LOG_ENABLED) {
        console.error(...args);
    }
}

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
    log("Attempting to find a working IDE endpoint...");

    // If user specified a port, just use that
    if (process.env.IDE_PORT) {
        log(`IDE_PORT is set to ${process.env.IDE_PORT}. Testing this port.`);
        const testEndpoint = `http://localhost:${process.env.IDE_PORT}/api`;
        if (await testListTools(testEndpoint)) {
            log(`IDE_PORT ${process.env.IDE_PORT} is working.`);
            return testEndpoint;
        } else {
            log(`Specified IDE_PORT=${process.env.IDE_PORT} but it is not responding correctly.`);
            throw new Error(`Specified IDE_PORT=${process.env.IDE_PORT} but it is not responding correctly.`);
        }
    }

    for (let port = 63342; port <= 63352; port++) {
        const candidateEndpoint = `http://localhost:${port}/api`;
        log(`Testing port ${port}...`);
        if (await testListTools(candidateEndpoint)) {
            log(`Found working IDE endpoint at ${candidateEndpoint}`);
            return candidateEndpoint;
        } else {
            log(`Port ${port} is not responding correctly.`);
        }
    }
    sendToolsChanged();
    previousResponse = "";
    log("No working IDE endpoint found in range 63342-63352");
    throw new Error("No working IDE endpoint found in range 63342-63352");
}

let previousResponse: string | null = null;

function sendToolsChanged() {
    try {
        log("Sending tools changed notification.");
        server.notification({method: "notifications/tools/list_changed"});
    } catch (error) {
        log("Error sending tools changed notification:", error);
    }
}

async function testListTools(endpoint: string): Promise<boolean> {
    log(`Sending test request to ${endpoint}/mcp/list_tools`);
    try {
        const res = await fetch(`${endpoint}/mcp/list_tools`);

        if (!res.ok) {
            log(`Test request to ${endpoint}/mcp/list_tools failed with status ${res.status}`);
            return false;
        }

        const currentResponse = await res.text();
        log(`Received response from ${endpoint}/mcp/list_tools: ${currentResponse.substring(0, 100)}...`);

        if (previousResponse !== null && previousResponse !== currentResponse) {
            log("Response has changed since the last check.");
            sendToolsChanged();
        }
        previousResponse = currentResponse;
        return true;
    } catch (error) {
        log(`Error during testListTools for endpoint ${endpoint}:`, error);
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
    log("Handling ListToolsRequestSchema request.");
    try {
        const endpoint = await findWorkingIDEEndpoint();
        log(`Using endpoint ${endpoint} to list tools.`);
        const toolsResponse = await fetch(`${endpoint}/mcp/list_tools`);
        if (!toolsResponse.ok) {
            log(`Failed to fetch tools from ${endpoint}/mcp/list_tools with status ${toolsResponse.status}`);
            throw new Error("Unable to list tools");
        }
        const tools = await toolsResponse.json();
        log(`Successfully fetched tools: ${JSON.stringify(tools)}`);
        return {tools};
    } catch (error) {
        log("Error handling ListToolsRequestSchema request:", error);
        throw error;
    }
});

async function handleToolCall(name: string, args: any): Promise<CallToolResult> {
    log(`Handling tool call: name=${name}, args=${JSON.stringify(args)}`);
    try {
        const endPoint = await findWorkingIDEEndpoint();
        log("ENDPOINT: " + endPoint + " " + name + " " + JSON.stringify(args));
        const response = await fetch(`${endPoint}/mcp/${name}`, {
            method: 'POST',
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(args)
        });

        if (!response.ok) {
            log(`Response failed with status ${response.status} for tool ${name}`);
            throw new Error(`Response failed: ${response.status}`);
        }

        log("Received response from tool call:", response);
        const {status, error}: IDEResponse = await response.json();

        log("Parsed response:", {status, error});

        const isError = !!error;
        const text = status ?? error;
        log("Final response text:", text);
        log("Is error:", isError);
        return {
            content: [{type: "text", text: text}],
            isError,
        };
    } catch (error: any) {
        log("Error in handleToolCall:", error);
        return {
            content: [{
                type: "text",
                text: error instanceof Error ? error.message : "Unknown error",
            }],
            isError: true,
        };
    }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    log("Handling CallToolRequestSchema request:", request);
    try {
        const result = await handleToolCall(request.params.name, request.params.arguments ?? {});
        log("Tool call handled successfully:", result);
        return result;
    } catch (error) {
        log("Error handling CallToolRequestSchema request:", error);
        throw error;
    }
});

async function runServer() {
    log("Initializing server...");
    const transport = new StdioServerTransport();
    try {
        await server.connect(transport);
        log("Server connected to transport.");
    } catch (error) {
        log("Error connecting server to transport:", error);
        throw error;
    }

    const checkEndpoint = () => {
        log("Rechecking IDE endpoint...");
        findWorkingIDEEndpoint().catch(err => {
            log("Error rechecking IDE endpoint:", err);
        });
    };

    // We need to recheck the IDE endpoint every 10 seconds since IDE might be closed or restarted
    setInterval(checkEndpoint, 10000);
    log("Set interval to recheck IDE endpoint every 10 seconds.");

    try {
        await checkEndpoint();
        log("Initial IDE endpoint check completed.");
    } catch (error) {
        log("Error during initial IDE endpoint check:", error);
    }

    log("JetBrains Proxy MCP Server running on stdio");
}

runServer().catch(error => {
    log("Server failed to start:", error);
});