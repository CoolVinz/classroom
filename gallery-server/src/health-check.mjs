import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

test("serves the Coolify health check", async (t) => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));

  const server = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))], {
    env: { ...process.env, DATABASE_URL: "postgres://localhost/classroom", DATABASE_SSL: "disable", PORT: String(port) },
    stdio: "ignore",
  });
  t.after(async () => {
    if (server.exitCode !== null) return;
    server.kill("SIGTERM");
    await once(server, "exit");
  });

  let response;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      response = await fetch(`http://127.0.0.1:${port}/__healthcheck`);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.equal(response?.status, 200);
  assert.equal(await response.text(), "OK");
  const protocol = await fetch(`http://127.0.0.1:${port}/__gallery_protocol`);
  assert.equal(protocol.status, 200);
  assert.equal(await protocol.text(), "patrol-v2");
  const activities = await fetch(`http://127.0.0.1:${port}/__live_activity_protocol`);
  assert.equal(activities.status, 200);
  assert.equal(await activities.text(), "live-activity-v2");
});
