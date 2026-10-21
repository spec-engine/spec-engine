// stdout is the JSON-RPC channel: every human-facing line goes to stderr, or
// it corrupts the stream. The process serves until stdin closes.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defineCommand } from "citty";
import { assertSpecPlatform, platformName } from "../indexer/discover";
import { buildMcpServer } from "../server/mcp";
import { platformDirArg, resolvePlatformDir } from "./_args";
import { handleNotAPlatform } from "./_shared";

export const mcpCommand = defineCommand({
  meta: {
    name: "mcp",
    description:
      "Serve Spec Engine as an MCP (Model Context Protocol) server over stdio — agent-native query/resolve/check/report tools.",
  },
  args: {
    platformDir: platformDirArg,
  },
  async run({ args }) {
    const platformDir = resolvePlatformDir(args);

    try {
      assertSpecPlatform(platformDir);
    } catch (e) {
      handleNotAPlatform(e);
    }

    const server = buildMcpServer(platformDir);
    console.error(`spec mcp: serving ${platformName(platformDir)} over stdio`);
    await server.connect(new StdioServerTransport());
    // connect() resolves once the transport is wired; the stdin listener
    // keeps the event loop alive until the harness disconnects.
  },
});
