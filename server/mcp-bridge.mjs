// stdio MCP server that Codex launches. It forwards Trellai's tools (ask_questions,
// check_checkpoint, create_cards…) to the running Trellai server over HTTP.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const base = `${process.env.TRELLAI_URL}/api/internal/mcp/${process.env.TRELLAI_TOKEN}`;

const server = new Server({ name: "trellai", version: "2.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const r = await fetch(`${base}/tools`);
  return { tools: r.ok ? await r.json() : [] };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const r = await fetch(`${base}/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: req.params.name, arguments: req.params.arguments ?? {} }),
  });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  return { content: [{ type: "text", text: j.text ?? j.error ?? "" }], isError: !r.ok };
});

await server.connect(new StdioServerTransport());
