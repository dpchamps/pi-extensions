import { createConnection, type Socket } from "node:net";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function connect(path: string, request?: unknown, halfClose = false) {
  const socket: Socket = createConnection(path);
  const first = deferred<Record<string, any>>();
  const messages: Array<Record<string, any>> = [];
  let pending = Buffer.alloc(0);
  const done = new Promise<Array<Record<string, any>>>((resolve, reject) => {
    socket.on("error", reject);
    socket.on("connect", () => {
      if (request === undefined) return;
      const line = `${JSON.stringify(request)}\n`;
      if (halfClose) socket.end(line);
      else socket.write(line);
    });
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      let index: number;
      while ((index = pending.indexOf(10)) >= 0) {
        const message = JSON.parse(pending.subarray(0, index).toString("utf8"));
        pending = pending.subarray(index + 1);
        messages.push(message);
        first.resolve(message);
      }
    });
    socket.on("end", () => resolve(messages));
    // A test may intentionally abandon its wait before receiving any result.
    socket.on("close", () => resolve(messages));
  });
  return { socket, messages, first: first.promise, done };
}

export async function exchange(path: string, request: unknown) {
  return await connect(path, request).done;
}
