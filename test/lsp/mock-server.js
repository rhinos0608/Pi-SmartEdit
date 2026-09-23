/**
 * Mock LSP Server for testing.
 *
 * Simple Node.js script that responds to LSP requests over stdio.
 * Handles Content-Length header parsing and JSON-RPC messages.
 */

let buffer = Buffer.alloc(0);

function sendMessage(msg) {
  const json = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n`;
  process.stdout.write(header + json);
}

/** Read one complete message from stdin using byte-based LSP framing. */
async function readMessage() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      await waitForData();
      continue;
    }

    const headerText = buffer.subarray(0, headerEnd).toString("ascii");
    const match = /(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/i.exec(headerText);
    if (!match) {
      // Discard one malformed header block so a later valid frame can recover.
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }

    const contentLength = Number.parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;
    if (buffer.length < bodyEnd) {
      await waitForData();
      continue;
    }

    const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
    buffer = buffer.subarray(bodyEnd);
    try {
      return JSON.parse(body);
    } catch {
      // Malformed JSON — skip the framed message and continue.
    }
  }
}

/** Wait for one more stdin chunk. */
function waitForData() {
  return new Promise((resolve) => {
    process.stdin.once("data", (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      resolve();
    });
  });
}

async function main() {
  // Wait for initialize request
  const init = await readMessage();

  if (init.method !== "initialize") {
    process.exit(1);
  }

  sendMessage({
    jsonrpc: "2.0",
    id: init.id,
    result: {
      capabilities: {
        textDocument: {
          diagnostic: { dynamicRegistration: true },
          definition: { dynamicRegistration: true },
          references: { dynamicRegistration: true },
          hover: { dynamicRegistration: true },
        },
      },
    },
  });

  const cancelledIds = new Set();

  // Process loop
  while (true) {
    let msg;
    try {
      msg = await readMessage();
    } catch (e) {
      process.exit(0);
    }

    if (!msg) continue;

    // Shutdown
    if (msg.method === "shutdown") {
      sendMessage({ jsonrpc: "2.0", id: msg.id, result: null });
      process.exit(0);
    }

    // Initialized notification — no response needed
    if (msg.method === "initialized") {
      continue;
    }

    // DidOpen — generate mock diagnostics based on content
    if (msg.method === "textDocument/didOpen") {
      const text = msg.params?.textDocument?.text || "";
      const uri = msg.params?.textDocument?.uri || "";
      const diagnostics = [];

      // Check for "ERROR" in content
      let re = /ERROR(\d+)?/g;
      let match;
      while ((match = re.exec(text)) !== null) {
        const before = text.slice(0, match.index);
        const lineNum = before.split("\n").length - 1;
        const col = before.split("\n").pop().length || 0;
        diagnostics.push({
          range: { start: { line: lineNum, character: col }, end: { line: lineNum, character: col + match[0].length } },
          severity: 1,
          message: `Mock error: ${match[0]}`,
          source: "mock-lsp",
        });
      }

      // Check for "WARNING" in content
      re = /WARNING(\d+)?/g;
      while ((match = re.exec(text)) !== null) {
        const before = text.slice(0, match.index);
        const lineNum = before.split("\n").length - 1;
        const col = before.split("\n").pop().length || 0;
        diagnostics.push({
          range: { start: { line: lineNum, character: col }, end: { line: lineNum, character: col + match[0].length } },
          severity: 2,
          message: `Mock warning: ${match[0]}`,
          source: "mock-lsp",
        });
      }

      sendMessage({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: { uri, diagnostics },
      });
      continue;
    }

    // Definition
    if (msg.method === "textDocument/definition") {
      const pos = msg.params?.position || { line: 0, character: 0 };
      sendMessage({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          uri: msg.params?.textDocument?.uri || "file:///test.ts",
          range: { start: { line: pos.line + 1, character: 0 }, end: { line: pos.line + 1, character: 10 } },
        },
      });
      continue;
    }

    // References
    if (msg.method === "textDocument/references") {
      sendMessage({
        jsonrpc: "2.0",
        id: msg.id,
        result: [{ uri: msg.params?.textDocument?.uri || "file:///test.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } } }],
      });
      continue;
    }

    // Hover
    if (msg.method === "textDocument/hover") {
      sendMessage({
        jsonrpc: "2.0",
        id: msg.id,
        result: { contents: "[MockHover] This is mock hover content for testing." },
      });
      continue;
    }

    // Unicode response — verifies byte-based Content-Length framing.
    if (msg.method === "test/unicode") {
      sendMessage({
        jsonrpc: "2.0",
        id: msg.id,
        result: { text: "naïve café 🦏" },
      });
      continue;
    }

    // Echo verifies client->server Content-Length is byte-based too.
    if (msg.method === "test/echo") {
      sendMessage({ jsonrpc: "2.0", id: msg.id, result: msg.params ?? null });
      continue;
    }

    // Emit a server request that deliberately reuses the client's id before
    // the real response. A correct client must not confuse id+method with a
    // response to its own request.
    if (msg.method === "test/collision") {
      sendMessage({
        jsonrpc: "2.0",
        id: msg.id,
        method: "workspace/configuration",
        params: { items: [] },
      });
      sendMessage({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
      continue;
    }

    // Hold this request open until the client sends $/cancelRequest.
    if (msg.method === "test/cancellable") {
      continue;
    }

    if (msg.method === "$/cancelRequest") {
      const id = msg.params?.id;
      cancelledIds.add(id);
      // A late cancellation response is valid server behavior; the client
      // should have already removed its local pending entry.
      sendMessage({
        jsonrpc: "2.0",
        id,
        error: { code: -32800, message: "Request cancelled" },
      });
      continue;
    }

    if (msg.method === "test/cancelSeen") {
      sendMessage({
        jsonrpc: "2.0",
        id: msg.id,
        result: { seen: cancelledIds.size > 0 },
      });
      continue;
    }

    // DidClose — no response needed
    if (msg.method === "textDocument/didClose") {
      continue;
    }

    // Unknown method
    sendMessage({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `Unknown method: ${msg.method}` },
    });
  }
}

main().catch((err) => {
  console.error("Mock LSP error:", err.message);
  process.exit(1);
});
