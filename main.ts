// Entrypoint: bridge between the forge server and the trial environment.
//
// The environment owns the trial. It tells this process where it lives
// through MAKEFUN_ENV_URL, then expects two things from us:
//   1. tell it which ephemeral port our server is listening on, and
//   2. stay alive, polling, until it says the trial is finished.
// The port is picked by the kernel (listen on 0). Port 8080 belongs to
// the environment itself and must never be bound by us.

import { createApp } from './app.ts';

// Longest a single HTTP round-trip to the environment may take before
// we give up on it and try again.
const REQUEST_TIMEOUT_MS = 30_000;

// Backoff for the polling loop: start here and double after every
// failed or slow attempt, up to the cap below.
const RETRY_FIRST_MS = 250;
const RETRY_MAX_MS = 5_000;

const envBase = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (envBase === '') {
  process.stderr.write(
    '[entry] MAKEFUN_ENV_URL is not set: there is no environment to talk to\n',
  );
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One HTTP call against the environment, with a hard timeout. Returns
// the parsed JSON body, or null when the call failed, timed out, or
// the body was not JSON.
async function callEnv(path: string, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${envBase}${path}`, {
      ...init,
      signal: controller.signal,
    });
    if (!response.ok && response.status !== 409) {
      return null;
    }
    try {
      return await response.json();
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const server = createApp();

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server did not bind a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });

  // Register once. A 409 just means another entry got there first;
  // either way the trial proceeds and we move on to polling.
  await callEnv('/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
  });

  // Wait for the environment to declare the trial over. Nothing else
  // ends this process: no error, no timeout, no signal from the suite
  // short of {"done": true} may cut the wait short.
  let delay = RETRY_FIRST_MS;
  for (;;) {
    const body = await callEnv('/done');
    if (
      body !== null &&
      typeof body === 'object' &&
      (body as { done?: unknown }).done === true
    ) {
      break;
    }
    await sleep(delay);
    delay = Math.min(delay * 2, RETRY_MAX_MS);
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

main().catch((error: unknown) => {
  process.stderr.write(`[entry] fatal: ${String(error)}\n`);
  process.exit(1);
});
