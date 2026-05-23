import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { HttpConfig } from "./config.js";

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function checkAuth(req: IncomingMessage, expectedToken: string): boolean {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return false;
  const m = /^Bearer\s+(.+)$/.exec(header.trim());
  if (!m) return false;
  return constantTimeEqual(m[1], expectedToken);
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Length", Buffer.byteLength(payload).toString());
  res.end(payload);
}

export async function startHttpTransport(
  mcp: McpServer,
  cfg: HttpConfig,
): Promise<http.Server> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });
  await mcp.connect(transport);

  const httpServer = http.createServer(async (req, res) => {
    const url = req.url ?? "/";

    // Health endpoint — no auth, no MCP routing
    if (url === "/health" && req.method === "GET") {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Anything else lives under HTTP_PATH (default /mcp)
    if (url !== cfg.path && !url.startsWith(`${cfg.path}?`)) {
      sendJson(res, 404, { error: "not_found", path: url });
      return;
    }

    if (!checkAuth(req, cfg.authToken)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="host-mcp"');
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    try {
      await transport.handleRequest(req, res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal", message: msg });
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(cfg.port, cfg.host, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  return httpServer;
}
