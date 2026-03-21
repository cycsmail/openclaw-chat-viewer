import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getArchiveDir } from "./config.mjs";

// --- Password hashing ---

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) {
    return false;
  }
  const derived = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  if (derived.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(derived, expected);
}

// --- Session management ---

export const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const sessions = new Map();

export function createSession(username, role) {
  const token = randomBytes(32).toString("hex");
  sessions.set(token, { username, role, createdAt: Date.now() });
  return token;
}

export function getSession(token) {
  if (!token) {
    return null;
  }
  const session = sessions.get(token);
  if (!session) {
    return null;
  }
  if (Date.now() - session.createdAt > SESSION_MAX_AGE_MS) {
    sessions.delete(token);
    return null;
  }
  return session;
}

export function destroySession(token) {
  sessions.delete(token);
}

// --- User storage ---

function getUsersPath() {
  return path.join(getArchiveDir(), "users.json");
}

export async function loadUsers() {
  let raw;
  try {
    raw = await fs.readFile(getUsersPath(), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveUsers(users) {
  const usersPath = getUsersPath();
  const dir = path.dirname(usersPath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = usersPath + ".tmp." + randomBytes(4).toString("hex");
  await fs.writeFile(tmpPath, JSON.stringify(users, null, 2), "utf8");
  await fs.rename(tmpPath, usersPath);
}

export async function ensureAdminUser() {
  const users = await loadUsers();
  if (users.length > 0) {
    return;
  }
  const defaultPassword = process.env.OPENCLAW_ADMIN_PASSWORD || "admin";
  const admin = {
    username: "admin",
    passwordHash: hashPassword(defaultPassword),
    role: "admin",
    enabled: true,
    createdAt: new Date().toISOString()
  };
  await saveUsers([admin]);
}

function validateUsername(username) {
  if (!username || typeof username !== "string") {
    throw new Error("Invalid username");
  }
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(username)) {
    throw new Error("Invalid username");
  }
}

export async function addUser(username, password, role) {
  validateUsername(username);
  if (!password || typeof password !== "string") {
    throw new Error("Invalid credentials");
  }
  if (role !== "admin" && role !== "viewer") {
    role = "viewer";
  }
  const users = await loadUsers();
  if (users.some((u) => u.username === username)) {
    throw new Error("Username already exists");
  }
  const user = {
    username,
    passwordHash: hashPassword(password),
    role,
    enabled: true,
    createdAt: new Date().toISOString()
  };
  users.push(user);
  await saveUsers(users);
  return user;
}

export async function updateUser(username, updates) {
  validateUsername(username);
  const users = await loadUsers();
  const user = users.find((u) => u.username === username);
  if (!user) {
    throw new Error("Unauthorized");
  }
  if (updates.password && typeof updates.password === "string") {
    user.passwordHash = hashPassword(updates.password);
  }
  if (updates.role === "admin" || updates.role === "viewer") {
    user.role = updates.role;
  }
  if (typeof updates.enabled === "boolean") {
    user.enabled = updates.enabled;
  }
  await saveUsers(users);
  return user;
}

export async function removeUser(username) {
  validateUsername(username);
  const users = await loadUsers();
  const admins = users.filter((u) => u.role === "admin" && u.enabled !== false);
  const target = users.find((u) => u.username === username);
  if (!target) {
    throw new Error("Unauthorized");
  }
  if (target.role === "admin" && admins.length <= 1) {
    throw new Error("Cannot remove last admin");
  }
  const remaining = users.filter((u) => u.username !== username);
  await saveUsers(remaining);
  return { ok: true };
}

export async function authenticateUser(username, password) {
  if (!username || !password) {
    return null;
  }
  const users = await loadUsers();
  const user = users.find((u) => u.username === username);
  if (!user) {
    return null;
  }
  if (user.enabled === false) {
    return null;
  }
  if (!verifyPassword(password, user.passwordHash)) {
    return null;
  }
  return { username: user.username, role: user.role };
}

// --- Cookie helpers ---

export function getSessionCookie(req) {
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.match(/(?:^|;\s*)ocv_session=([^\s;]+)/);
  return match ? match[1] : "";
}

export function setSessionCookie(res, token) {
  const existing = res.getHeader("Set-Cookie") || [];
  const cookies = Array.isArray(existing) ? existing : (existing ? [existing] : []);
  cookies.push(`ocv_session=${token}; HttpOnly; SameSite=Lax; Path=/`);
  res.setHeader("Set-Cookie", cookies);
}

export function clearSessionCookie(res) {
  const existing = res.getHeader("Set-Cookie") || [];
  const cookies = Array.isArray(existing) ? existing : (existing ? [existing] : []);
  cookies.push("ocv_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  res.setHeader("Set-Cookie", cookies);
}
