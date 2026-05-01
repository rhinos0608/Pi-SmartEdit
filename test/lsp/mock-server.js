/**
 * Mock LSP Server for testing.
 *
 * Simple Node.js script that responds to LSP requests over stdio.
 * Handles Content-Length header parsing and JSON-RPC messages.
 */

let buffer = "";
let contentLength = -1;

function sendMessage(msg) {
  const json = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n`;
  process.stdout.write(header + json);
}

/** Read one complete message from stdin. */
async function readMessage() {
  while (true) {
    // Try to parse from buffer
    if (contentLength === -1) {
      // Look for Content-Length header
      const match = buffer.match(/^Content-Length:\s*(\d+)\r\n/i);
      if (match) {
        contentLength = parseInt(match[1], 10);
        buffer = buffer.slice(match[0].length);
      } else {
        // Need more data
        await waitForData();
        continue;
      }
    }

    // Skip the \r\n after Content-Length header
    if (buffer.startsWith("\r\n")) {
      buffer = buffer.slice(2);
    }

    // Check if we have enough data for the body
    if (buffer.length >= contentLength) {
      const body = buffer.slice(0, contentLength);
      buffer = buffer.slice(contentLength);
      contentLength = -1;
      try {
        return JSON.parse(body);
      } catch {
        // Malformed JSON — try to continue
        continue;
      }
    }

    await waitForData();
  }
}

/** Wait for data on stdin. */
function waitForData() {
  return new Promise((resolve) => {
    let settled = false;
    const handler = (chunk) => {
      if (settled) return;
      settled = true;
      buffer += chunk.toString();
      process.stdin.removeListener("data", handler);
      resolve();
    };
    process.stdin.on("data", handler);
    if (buffer.length > 0) {
      if (settled) return;
      settled = true;
      process.stdin.removeListener("data", handler);
      resolve();
    }
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
