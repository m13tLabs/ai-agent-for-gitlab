import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export interface MockResponse {
  status?: number;
  body?: unknown;
}

export interface GitLabMock {
  url: string;
  requests: RecordedRequest[];
  // Answers every request; default 201 {"id": 1}.
  respond(res: MockResponse): void;
  close(): Promise<void>;
}

// Minimal GitLab REST stand-in: records requests and answers with a fixed response.
export async function startGitLabMock(): Promise<GitLabMock> {
  const requests: RecordedRequest[] = [];
  let response: MockResponse = { status: 201, body: { id: 1 } };

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk));
    req.on("end", () => {
      let body: unknown = raw;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        // keep raw text
      }
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      res.writeHead(response.status ?? 200, { "Content-Type": "application/json" });
      res.end(typeof response.body === "string" ? response.body : JSON.stringify(response.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    respond(res) {
      response = res;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// Keeps logger output out of the test report.
export function silenceConsole(): void {
  for (const method of ["log", "warn", "error"] as const) {
    mock.method(console, method, () => {});
  }
}

export function tempDir(prefix = "agent-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// A URL on which nothing listens, so requests fail fast.
export const UNREACHABLE_URL = "http://127.0.0.1:9";
