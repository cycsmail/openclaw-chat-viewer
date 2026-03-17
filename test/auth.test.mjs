import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  hashPassword, verifyPassword,
  createSession, getSession, destroySession,
  ensureAdminUser, addUser, updateUser, removeUser,
  authenticateUser, loadUsers, saveUsers,
  getSessionCookie, setSessionCookie, clearSessionCookie
} from "../lib/auth.mjs";
import { initConfig } from "../lib/config.mjs";

async function withTmpArchive(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "auth-test-"));
  const archiveDir = path.join(root, "viewer-archive");
  await fs.mkdir(archiveDir, { recursive: true });
  await fs.mkdir(path.join(root, "agents"), { recursive: true });

  const origHome = process.env.OPENCLAW_HOME;
  const origPassword = process.env.OPENCLAW_ADMIN_PASSWORD;
  process.env.OPENCLAW_HOME = root;
  delete process.env.OPENCLAW_ADMIN_PASSWORD;
  initConfig();

  try {
    await fn(root, archiveDir);
  } finally {
    if (origHome !== undefined) {
      process.env.OPENCLAW_HOME = origHome;
    } else {
      delete process.env.OPENCLAW_HOME;
    }
    if (origPassword !== undefined) {
      process.env.OPENCLAW_ADMIN_PASSWORD = origPassword;
    }
    initConfig();
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("hashPassword and verifyPassword round-trip", () => {
  const hash = hashPassword("testpass");
  assert.ok(hash.includes(":"));
  assert.ok(verifyPassword("testpass", hash));
  assert.ok(!verifyPassword("wrongpass", hash));
  assert.ok(!verifyPassword("testpass", "invalid"));
});

test("createSession, getSession, destroySession", () => {
  const token = createSession("alice", "admin");
  assert.ok(typeof token === "string");
  assert.ok(token.length >= 32);

  const session = getSession(token);
  assert.ok(session);
  assert.equal(session.username, "alice");
  assert.equal(session.role, "admin");

  destroySession(token);
  assert.equal(getSession(token), null);
});

test("getSession returns null for missing token", () => {
  assert.equal(getSession(""), null);
  assert.equal(getSession(null), null);
  assert.equal(getSession("nonexistent"), null);
});

test("ensureAdminUser creates admin on first run", async () => {
  await withTmpArchive(async () => {
    await ensureAdminUser();
    const users = await loadUsers();
    assert.equal(users.length, 1);
    assert.equal(users[0].username, "admin");
    assert.equal(users[0].role, "admin");
    assert.ok(verifyPassword("admin", users[0].passwordHash));
  });
});

test("ensureAdminUser does not overwrite existing users", async () => {
  await withTmpArchive(async () => {
    await ensureAdminUser();
    await addUser("bob", "bobpass", "viewer");

    await ensureAdminUser();
    const users = await loadUsers();
    assert.equal(users.length, 2);
  });
});

test("ensureAdminUser uses OPENCLAW_ADMIN_PASSWORD env var", async () => {
  await withTmpArchive(async () => {
    process.env.OPENCLAW_ADMIN_PASSWORD = "custom-pass";
    await ensureAdminUser();
    const users = await loadUsers();
    assert.ok(verifyPassword("custom-pass", users[0].passwordHash));
    delete process.env.OPENCLAW_ADMIN_PASSWORD;
  });
});

test("addUser creates new user", async () => {
  await withTmpArchive(async () => {
    await ensureAdminUser();
    const user = await addUser("viewer1", "pass123", "viewer");
    assert.equal(user.username, "viewer1");
    assert.equal(user.role, "viewer");

    const users = await loadUsers();
    assert.equal(users.length, 2);
  });
});

test("addUser rejects duplicate username", async () => {
  await withTmpArchive(async () => {
    await ensureAdminUser();
    await assert.rejects(
      () => addUser("admin", "otherpass", "viewer"),
      /Username already exists/
    );
  });
});

test("addUser rejects invalid username", async () => {
  await withTmpArchive(async () => {
    await ensureAdminUser();
    await assert.rejects(() => addUser("", "pass", "viewer"), /Invalid username/);
    await assert.rejects(() => addUser("bad user!", "pass", "viewer"), /Invalid username/);
  });
});

test("updateUser changes password and role", async () => {
  await withTmpArchive(async () => {
    await ensureAdminUser();
    await addUser("editor", "oldpass", "viewer");

    await updateUser("editor", { password: "newpass", role: "admin" });
    const user = await authenticateUser("editor", "newpass");
    assert.ok(user);
    assert.equal(user.role, "admin");

    const oldAuth = await authenticateUser("editor", "oldpass");
    assert.equal(oldAuth, null);
  });
});

test("removeUser deletes non-admin user", async () => {
  await withTmpArchive(async () => {
    await ensureAdminUser();
    await addUser("temp", "pass", "viewer");
    await removeUser("temp");

    const users = await loadUsers();
    assert.equal(users.length, 1);
    assert.equal(users[0].username, "admin");
  });
});

test("removeUser cannot remove last admin", async () => {
  await withTmpArchive(async () => {
    await ensureAdminUser();
    await assert.rejects(
      () => removeUser("admin"),
      /Cannot remove last admin/
    );
  });
});

test("removeUser allows removing admin when another admin exists", async () => {
  await withTmpArchive(async () => {
    await ensureAdminUser();
    await addUser("admin2", "pass", "admin");
    await removeUser("admin");

    const users = await loadUsers();
    assert.equal(users.length, 1);
    assert.equal(users[0].username, "admin2");
  });
});

test("authenticateUser with correct and wrong passwords", async () => {
  await withTmpArchive(async () => {
    await ensureAdminUser();
    const user = await authenticateUser("admin", "admin");
    assert.ok(user);
    assert.equal(user.username, "admin");
    assert.equal(user.role, "admin");

    const wrong = await authenticateUser("admin", "wrongpass");
    assert.equal(wrong, null);

    const missing = await authenticateUser("nobody", "pass");
    assert.equal(missing, null);
  });
});

test("authenticateUser rejects disabled users", async () => {
  await withTmpArchive(async () => {
    await ensureAdminUser();
    await addUser("disabled-user", "pass", "viewer");
    await updateUser("disabled-user", { enabled: false });

    const result = await authenticateUser("disabled-user", "pass");
    assert.equal(result, null);
  });
});

test("cookie helpers parse and set session cookies", () => {
  const mockReq = { headers: { cookie: "other=val; ocv_session=abc123; more=data" } };
  assert.equal(getSessionCookie(mockReq), "abc123");

  const mockReqNone = { headers: {} };
  assert.equal(getSessionCookie(mockReqNone), "");

  const headers = {};
  const mockRes = {
    getHeader: (name) => headers[name],
    setHeader: (name, value) => { headers[name] = value; }
  };

  setSessionCookie(mockRes, "token123");
  const cookies = headers["Set-Cookie"];
  assert.ok(Array.isArray(cookies));
  assert.ok(cookies[0].includes("ocv_session=token123"));
  assert.ok(cookies[0].includes("HttpOnly"));
  assert.ok(cookies[0].includes("SameSite=Lax"));

  clearSessionCookie(mockRes);
  assert.ok(cookies[1].includes("Max-Age=0"));
});

test("API endpoints: login, me, logout via HTTP", async () => {
  await withTmpArchive(async (root) => {
    process.env.OPENCLAW_HOME = root;
    process.env.OPENCLAW_MONITOR_NO_LISTEN = "1";
    initConfig();
    await ensureAdminUser();

    const { createServer } = await import(`../server.mjs?t=${Date.now()}-${Math.random()}`);
    const server = createServer();

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    try {
      // Login with wrong credentials
      const badRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "wrong" })
      });
      assert.equal(badRes.status, 401);

      // Login with correct credentials
      const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "admin" })
      });
      assert.equal(loginRes.status, 200);
      const loginData = await loginRes.json();
      assert.ok(loginData.ok);
      assert.equal(loginData.user.username, "admin");

      const setCookie = loginRes.headers.get("set-cookie");
      assert.ok(setCookie);
      const sessionMatch = setCookie.match(/ocv_session=([^;]+)/);
      assert.ok(sessionMatch);
      const sessionToken = sessionMatch[1];

      // /api/auth/me with session cookie
      const meRes = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
        headers: { Cookie: `ocv_session=${sessionToken}` }
      });
      assert.equal(meRes.status, 200);
      const meData = await meRes.json();
      assert.equal(meData.user.username, "admin");

      // Unauthenticated /api/overview should return 401
      const noAuthRes = await fetch(`http://127.0.0.1:${port}/api/overview`);
      assert.equal(noAuthRes.status, 401);

      // Unauthenticated page request should redirect to /login
      const pageRes = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
      assert.equal(pageRes.status, 302);
      assert.equal(pageRes.headers.get("location"), "/login");

      // /api/health should work without auth
      const healthRes = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(healthRes.status, 200);

      // Logout
      const logoutRes = await fetch(`http://127.0.0.1:${port}/api/auth/logout`, {
        method: "POST",
        headers: { Cookie: `ocv_session=${sessionToken}` }
      });
      assert.equal(logoutRes.status, 200);

      // After logout, session should be invalid
      const afterLogoutRes = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
        headers: { Cookie: `ocv_session=${sessionToken}` }
      });
      assert.equal(afterLogoutRes.status, 401);
    } finally {
      server.close();
    }
  });
});

test("User CRUD API endpoints", async () => {
  await withTmpArchive(async (root) => {
    process.env.OPENCLAW_HOME = root;
    process.env.OPENCLAW_MONITOR_NO_LISTEN = "1";
    initConfig();
    await ensureAdminUser();

    const { createServer } = await import(`../server.mjs?t=${Date.now()}-${Math.random()}`);
    const server = createServer();

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    try {
      // Login as admin
      const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "admin" })
      });
      const setCookie = loginRes.headers.get("set-cookie");
      const sessionToken = setCookie.match(/ocv_session=([^;]+)/)[1];
      const cookie = `ocv_session=${sessionToken}`;
      const origin = `http://127.0.0.1:${port}`;

      // Add user
      const addRes = await fetch(`http://127.0.0.1:${port}/api/users`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          "X-OpenClaw-Action": "user-add",
          Origin: origin
        },
        body: JSON.stringify({ username: "newuser", password: "newpass", role: "viewer" })
      });
      assert.equal(addRes.status, 200);

      // List users
      const listRes = await fetch(`http://127.0.0.1:${port}/api/users`, {
        headers: { Cookie: cookie }
      });
      const users = await listRes.json();
      assert.equal(users.length, 2);
      assert.ok(!users[0].passwordHash);

      // Update user
      const updateRes = await fetch(`http://127.0.0.1:${port}/api/users/update`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          "X-OpenClaw-Action": "user-update",
          Origin: origin
        },
        body: JSON.stringify({ username: "newuser", role: "admin" })
      });
      assert.equal(updateRes.status, 200);

      // Delete user
      const deleteRes = await fetch(`http://127.0.0.1:${port}/api/users/delete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          "X-OpenClaw-Action": "user-delete",
          Origin: origin
        },
        body: JSON.stringify({ username: "newuser" })
      });
      assert.equal(deleteRes.status, 200);

      // Verify user is deleted
      const listRes2 = await fetch(`http://127.0.0.1:${port}/api/users`, {
        headers: { Cookie: cookie }
      });
      const users2 = await listRes2.json();
      assert.equal(users2.length, 1);
    } finally {
      server.close();
    }
  });
});

test("Non-admin cannot access user management endpoints", async () => {
  await withTmpArchive(async (root) => {
    process.env.OPENCLAW_HOME = root;
    process.env.OPENCLAW_MONITOR_NO_LISTEN = "1";
    initConfig();
    await ensureAdminUser();
    await addUser("viewer1", "viewerpass", "viewer");

    const { createServer } = await import(`../server.mjs?t=${Date.now()}-${Math.random()}`);
    const server = createServer();

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    try {
      // Login as viewer
      const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "viewer1", password: "viewerpass" })
      });
      const setCookie = loginRes.headers.get("set-cookie");
      const sessionToken = setCookie.match(/ocv_session=([^;]+)/)[1];
      const cookie = `ocv_session=${sessionToken}`;

      // Try to list users
      const listRes = await fetch(`http://127.0.0.1:${port}/api/users`, {
        headers: { Cookie: cookie }
      });
      assert.equal(listRes.status, 403);
    } finally {
      server.close();
    }
  });
});
