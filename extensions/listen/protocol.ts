/** Local protocol only: one UTF-8 JSON object + LF per Unix stream connection. */
export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const MAX_FRAME_BYTES = 512 * 1024;
export const MAX_OUTPUT_BYTES = 256 * 1024;
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_RECORDS = 256;
export const MAX_PENDING = 32;

export type RequestStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "interrupted";

export interface RequestRecord {
  version: 1;
  id: string;
  input: string;
  token: string;
  status: RequestStatus;
  createdAt: string;
  updatedAt: string;
  message?: string;
  error?: string;
  truncated?: boolean;
}

export type Request =
  | { op: "submit"; id: string; message: string; wait: boolean }
  | { op: "get"; id: string; wait: boolean };

export interface Reply {
  type: "received" | "status" | "response";
  id: string;
  status: RequestStatus;
  createdAt: string;
  updatedAt: string;
  message?: string;
  error?: string;
  truncated?: boolean;
}

export class ProtocolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function isTerminal(status: RequestStatus): boolean {
  return status !== "queued" && status !== "running";
}

export function parseRequest(value: unknown): Request {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProtocolError("invalid_request", "Expected a JSON object");
  const data = value as Record<string, unknown>;
  if (data.version !== undefined && data.version !== PROTOCOL_VERSION)
    throw new ProtocolError(
      "unsupported_version",
      "Only protocol version 1 is supported",
    );
  if (data.op !== "submit" && data.op !== "get")
    throw new ProtocolError("invalid_request", "op must be submit or get");
  if (
    typeof data.id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(data.id)
  )
    throw new ProtocolError(
      "invalid_request",
      "id must be 1-128 ASCII letters, digits, dots, underscores or hyphens, starting with a letter or digit",
    );
  if (data.wait !== undefined && typeof data.wait !== "boolean")
    throw new ProtocolError("invalid_request", "wait must be a boolean");
  const allowed = new Set([
    "version",
    "op",
    "id",
    "wait",
    ...(data.op === "submit" ? ["message"] : []),
  ]);
  for (const key of Object.keys(data))
    if (!allowed.has(key))
      throw new ProtocolError("invalid_request", `Unknown field: ${key}`);
  if (data.op === "get")
    return { op: "get", id: data.id, wait: data.wait === true };
  if (typeof data.message !== "string" || !data.message.trim())
    throw new ProtocolError(
      "invalid_request",
      "message must be non-empty text",
    );
  if (Buffer.byteLength(data.message, "utf8") > MAX_MESSAGE_BYTES)
    throw new ProtocolError(
      "message_too_large",
      `message exceeds ${MAX_MESSAGE_BYTES} UTF-8 bytes`,
    );
  return {
    op: "submit",
    id: data.id,
    message: data.message,
    wait: data.wait !== false,
  };
}

/** Never expose the input, delivery token, thinking, tool results or transcript. */
export function reply(record: RequestRecord, type: Reply["type"]): Reply {
  return {
    type,
    id: record.id,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.message !== undefined ? { message: record.message } : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
    ...(record.truncated ? { truncated: true } : {}),
  };
}

export function boundedText(
  text: string,
  maxBytes = MAX_OUTPUT_BYTES,
): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}
