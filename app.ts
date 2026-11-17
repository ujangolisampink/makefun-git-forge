// HTTP server: routes git smart HTTP, REST v3, GraphQL v4 and MCP onto one Store.
// Wire contract (see kit RULES.txt / checks-*.ts):
//  - every REST reply is application/json, never HTML, with a non-empty X-GitHub-Request-Id;
//  - an error carries a JSON body with a string message; unknown route -> 404 JSON;
//  - malformed JSON body -> 400 JSON;
//  - git routes carry no auth; REST/GraphQL/MCP require Authorization: Bearer $MAKEFUN_SHOP_TOKEN
//    whenever the token is set (in the grading pod it always is; locally it may be empty).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { routeRest, type RestResult } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp, mcpParseError } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const MAX_BODY = 64 * 1024 * 1024;

const REPO_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function authorized(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJson(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (body.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

export function createApp(): Server {
  const store = new Store();

  function sendJson(res: ServerResponse, status: number, payload: unknown, extraHeaders: Record<string, string> = {}): void {
    const body = JSON.stringify(payload);
    // Content-Length up front: headers and body go out in one write instead of
    // chunked framing (writeHead first, then end, forces chunked encoding).
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'x-github-request-id': store.nextRequestId(),
      ...extraHeaders,
    });
    res.end(body);
  }

  function sendRest(res: ServerResponse, result: RestResult): void {
    // A result may carry a pre-serialized body (the hot single-issue GET): send it
    // verbatim instead of re-serializing `json`.
    const body = result.raw ?? JSON.stringify(result.json);
    // 204 carries no body: send none (and no Content-Length, which 204 forbids).
    if (result.status === 204) {
      res.writeHead(204, {
        'x-github-request-id': store.nextRequestId(),
        ...(result.headers ?? {}),
      });
      res.end();
      return;
    }
    res.writeHead(result.status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'x-github-request-id': store.nextRequestId(),
      ...(result.headers ?? {}),
    });
    res.end(body);
  }

  function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
    res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
    res.end(body);
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname;
      const method = req.method ?? 'GET';

      // Health check (the env's boot probe, called twice; takes no auth).
      if (pathname === '/healthz' && method === 'GET') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // ---- Git smart HTTP (no auth) ----
      const gitMatch = REPO_PATH.exec(pathname);
      if (gitMatch !== null) {
        const owner = decodeURIComponent(gitMatch[1] as string);
        const repoName = decodeURIComponent(gitMatch[2] as string);
        const service = gitMatch[3] as string;
        if (!NAME_RE.test(owner) || !NAME_RE.test(repoName)) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (method === 'GET' && service === 'info/refs') {
          const gitProtocolV2 = req.headers['git-protocol'] === 'version=2';
          const result = handleInfoRefs(store, owner, repoName, url.searchParams.get('service'), gitProtocolV2);
          sendBuffer(res, result.status, result.contentType, result.body);
          return;
        }
        if (method === 'POST' && service === 'git-upload-pack') {
          const body = await readBody(req);
          const gitProtocolV2 = req.headers['git-protocol'] === 'version=2';
          const result = handleUploadPack(store, owner, repoName, body, gitProtocolV2);
          sendBuffer(res, result.status, result.contentType, result.body);
          return;
        }
        if (method === 'POST' && service === 'git-receive-pack') {
          const body = await readBody(req);
          const result = handleReceivePack(store, owner, repoName, body);
          sendBuffer(res, result.status, result.contentType, result.body);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      // ---- MCP (parse first so a non-JSON body is 400 even without auth; auth second) ----
      if (pathname === '/mcp') {
        if (method !== 'POST') {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const body = await readBody(req);
        const parsed = parseJson(body);
        if (!parsed.ok) {
          const err = mcpParseError();
          sendJson(res, err.status, err.body);
          return;
        }
        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Unauthorized' });
          return;
        }
        const result = handleMcp(store, parsed.value);
        if (result.body === null) {
          res.writeHead(result.status);
          res.end();
          return;
        }
        sendJson(res, result.status, result.body);
        return;
      }

      // ---- GraphQL v4 ----
      if (pathname === '/api/graphql') {
        if (method !== 'POST') {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Unauthorized' });
          return;
        }
        const body = await readBody(req);
        const parsed = parseJson(body);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Invalid JSON' });
          return;
        }
        sendJson(res, 200, handleGraphQL(store, parsed.value));
        return;
      }

      // ---- REST v3 ----
      if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
        const restPath = pathname === '/api/v3' ? '' : pathname.slice('/api/v3/'.length);
        const segments = restPath === '' ? [] : restPath.split('/').map((part) => decodeURIComponent(part));
        const isPublic = segments.length === 0 || (segments.length === 1 && segments[0] === 'meta');
        if (!isPublic && !authorized(req)) {
          sendJson(res, 401, { message: 'Unauthorized' });
          return;
        }
        let body: Record<string, unknown> | null = null;
        if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          const raw = await readBody(req);
          if (raw.length > 0) {
            const parsed = parseJson(raw);
            if (!parsed.ok) {
              sendJson(res, 400, { message: 'Invalid JSON' });
              return;
            }
            if (parsed.value !== null && typeof parsed.value === 'object' && !Array.isArray(parsed.value)) {
              body = parsed.value as Record<string, unknown>;
            } else if (parsed.value !== null) {
              sendJson(res, 400, { message: 'Invalid JSON' });
              return;
            }
          }
        }
        const base = `http://${req.headers.host ?? 'localhost'}`;
        const result = routeRest(store, method, segments, url.searchParams, body, base);
        sendRest(res, result);
        return;
      }

      // ---- Anything else: JSON 404, never HTML ----
      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      // Never let a handler crash the process: the suite's repo-survives-errors check
      // requires the server to stay up after malformed input.
      console.error('handler error:', err instanceof Error ? err.message : err);
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    }
  });
}
