#!/usr/bin/env node
// Dependency-free client. Keeps the duplex socket open; tool timeouts can be
// recovered with another get using the same request id.
import { createConnection } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [directory, op, id, ...args] = process.argv.slice(2);
function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

if (!directory || !id || !["submit", "get"].includes(op)) {
  fail(
    "Usage: node client.mjs DIR submit ID MESSAGE|- [--no-wait]\n       node client.mjs DIR get ID [--wait]",
  );
} else {
  let request;
  if (
    op === "submit" &&
    (args.length === 1 || (args.length === 2 && args[1] === "--no-wait"))
  ) {
    request = {
      op,
      id,
      message: args[0] === "-" ? readFileSync(0, "utf8") : args[0],
      wait: args[1] !== "--no-wait",
    };
  } else if (
    op === "get" &&
    (args.length === 0 || (args.length === 1 && args[0] === "--wait"))
  ) {
    request = { op, id, wait: args[0] === "--wait" };
  } else
    fail(
      "Invalid arguments; submit needs one message, get accepts only --wait",
    );

  if (request) {
    const socket = createConnection(join(directory, "inbox.sock"));
    let pending = Buffer.alloc(0);
    let final = false;
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("error", (error) =>
      fail(
        `Connection error: ${error.message}. Recover using get with id ${JSON.stringify(id)}.`,
      ),
    );
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      // A response can JSON-escape every byte of its 256 KiB text.
      if (pending.length > 2 * 1024 * 1024) {
        fail("Response frame exceeded 2 MiB");
        socket.destroy();
        return;
      }
      let newline;
      while ((newline = pending.indexOf(10)) !== -1) {
        const frame = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        try {
          const response = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(frame),
          );
          process.stdout.write(`${JSON.stringify(response)}\n`);
          if (response.type === "error") {
            process.exitCode = 1;
            final = true;
          } else if (response.id !== id) {
            throw new Error("Mismatched response id");
          } else if (response.type === "response" || !request.wait) {
            final = true;
            if (
              response.status === "failed" ||
              response.status === "interrupted"
            )
              process.exitCode = 2;
          }
        } catch (error) {
          fail(`Invalid response: ${error.message}`);
          socket.destroy();
          return;
        }
      }
    });
    socket.on("end", () => {
      if (pending.length || !final)
        fail(
          `Connection ended without a complete response. Recover using get with id ${JSON.stringify(id)}.`,
        );
    });
    // A peer's normal end closes this client automatically. SIGINT/termination
    // only closes the connection; no cancellation request is sent.
  }
}
