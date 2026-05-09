const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const TOKEN_SECRET = process.env.TOKEN_SECRET || "local-dev-secret-change-me";

const sockets = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml"
};

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    const now = new Date().toISOString();
    const password = hashPassword("demo123");
    const demo = {
      users: [
        { id: id(), name: "Demo Manager", email: "demo@example.com", password, createdAt: now }
      ],
      projects: [],
      boards: [],
      tasks: [],
      comments: [],
      notifications: []
    };
    const userId = demo.users[0].id;
    const projectId = id();
    const boardId = id();
    demo.projects.push({
      id: projectId,
      name: "Product Launch",
      description: "Coordinate work across design, development, and release.",
      ownerId: userId,
      memberIds: [userId],
      createdAt: now
    });
    demo.boards.push({
      id: boardId,
      projectId,
      name: "Launch Board",
      columns: ["Backlog", "In Progress", "Review", "Done"],
      createdAt: now
    });
    demo.tasks.push(
      taskSeed(projectId, boardId, userId, "Draft roadmap", "Backlog", "High"),
      taskSeed(projectId, boardId, userId, "Create landing page copy", "In Progress", "Medium"),
      taskSeed(projectId, boardId, userId, "QA onboarding flow", "Review", "High")
    );
    writeDb(demo);
  }
}

function taskSeed(projectId, boardId, userId, title, status, priority) {
  const now = new Date().toISOString();
  return {
    id: id(),
    projectId,
    boardId,
    title,
    description: "Add details, assign ownership, and track progress from here.",
    status,
    priority,
    assigneeId: userId,
    dueDate: "",
    createdBy: userId,
    createdAt: now,
    updatedAt: now
  };
}

function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function id() {
  return crypto.randomUUID();
}

function safeUser(user) {
  if (!user) return null;
  const { password, ...rest } = user;
  return rest;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expected] = stored.split(":");
  const actual = hashPassword(password, salt).split(":")[1];
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", TOKEN_SECRET).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifyToken(token) {
  if (!token || !token.includes(".")) return null;
  const [body, signature] = token.split(".");
  const expected = crypto.createHmac("sha256", TOKEN_SECRET).update(body).digest("base64url");
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (payload.exp && payload.exp < Date.now()) return null;
  return payload;
}

function send(res, status, data) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function notFound(res) {
  send(res, 404, { error: "Not found" });
}

function getBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body is too large"));
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
  });
}

function getAuth(req) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const payload = verifyToken(token);
  if (!payload) return null;
  const db = readDb();
  return db.users.find(user => user.id === payload.sub) || null;
}

function requireAuth(req, res) {
  const user = getAuth(req);
  if (!user) send(res, 401, { error: "Authentication required" });
  return user;
}

function canAccessProject(project, user) {
  return project && (project.ownerId === user.id || project.memberIds.includes(user.id));
}

function enrichProject(db, project) {
  const boards = db.boards.filter(board => board.projectId === project.id);
  const tasks = db.tasks.filter(task => task.projectId === project.id);
  const members = project.memberIds.map(userId => safeUser(db.users.find(user => user.id === userId))).filter(Boolean);
  return { ...project, boards, tasks, members };
}

function createNotification(db, userId, type, message, projectId, taskId = null) {
  const notification = {
    id: id(),
    userId,
    type,
    message,
    projectId,
    taskId,
    read: false,
    createdAt: new Date().toISOString()
  };
  db.notifications.unshift(notification);
  return notification;
}

function notifyProject(db, project, actorId, type, message, taskId = null) {
  const notifications = project.memberIds
    .filter(userId => userId !== actorId)
    .map(userId => createNotification(db, userId, type, message, project.id, taskId));
  broadcast(project.id, { type, message, taskId, notifications });
}

function broadcast(projectId, payload) {
  const text = JSON.stringify({ ...payload, projectId, at: new Date().toISOString() });
  for (const [, client] of sockets) {
    if (!client.projectIds.has(projectId)) continue;
    client.socket.write(encodeWebSocketFrame(text));
  }
}

async function handleApi(req, res, url) {
  try {
    if (req.method === "POST" && url.pathname === "/api/auth/register") {
      const body = await getBody(req);
      const name = String(body.name || "").trim();
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (!name || !email || password.length < 6) {
        return send(res, 400, { error: "Name, email, and a 6+ character password are required" });
      }
      const db = readDb();
      if (db.users.some(user => user.email === email)) return send(res, 409, { error: "Email is already registered" });
      const user = { id: id(), name, email, password: hashPassword(password), createdAt: new Date().toISOString() };
      db.users.push(user);
      writeDb(db);
      const token = signToken({ sub: user.id, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 });
      return send(res, 201, { token, user: safeUser(user) });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      const body = await getBody(req);
      const db = readDb();
      const user = db.users.find(item => item.email === String(body.email || "").trim().toLowerCase());
      if (!user || !verifyPassword(String(body.password || ""), user.password)) return send(res, 401, { error: "Invalid email or password" });
      const token = signToken({ sub: user.id, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 });
      return send(res, 200, { token, user: safeUser(user) });
    }

    const user = requireAuth(req, res);
    if (!user) return;

    if (req.method === "GET" && url.pathname === "/api/me") {
      const db = readDb();
      const notifications = db.notifications.filter(item => item.userId === user.id).slice(0, 30);
      return send(res, 200, { user: safeUser(user), notifications });
    }

    if (req.method === "GET" && url.pathname === "/api/users") {
      const db = readDb();
      return send(res, 200, { users: db.users.map(safeUser) });
    }

    if (req.method === "GET" && url.pathname === "/api/projects") {
      const db = readDb();
      const projects = db.projects.filter(project => canAccessProject(project, user)).map(project => enrichProject(db, project));
      return send(res, 200, { projects });
    }

    if (req.method === "POST" && url.pathname === "/api/projects") {
      const body = await getBody(req);
      const name = String(body.name || "").trim();
      if (!name) return send(res, 400, { error: "Project name is required" });
      const db = readDb();
      const now = new Date().toISOString();
      const project = {
        id: id(),
        name,
        description: String(body.description || "").trim(),
        ownerId: user.id,
        memberIds: Array.from(new Set([user.id, ...(body.memberIds || [])])),
        createdAt: now
      };
      const board = {
        id: id(),
        projectId: project.id,
        name: "Main Board",
        columns: ["Backlog", "In Progress", "Review", "Done"],
        createdAt: now
      };
      db.projects.push(project);
      db.boards.push(board);
      writeDb(db);
      broadcast(project.id, { type: "project_created", message: `${user.name} created ${project.name}` });
      return send(res, 201, { project: enrichProject(db, project) });
    }

    const projectTaskMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/tasks$/);
    if (projectTaskMatch && req.method === "POST") {
      const projectId = projectTaskMatch[1];
      const body = await getBody(req);
      const db = readDb();
      const project = db.projects.find(item => item.id === projectId);
      if (!canAccessProject(project, user)) return send(res, 403, { error: "Project access denied" });
      const board = db.boards.find(item => item.projectId === projectId);
      const title = String(body.title || "").trim();
      if (!title) return send(res, 400, { error: "Task title is required" });
      const now = new Date().toISOString();
      const task = {
        id: id(),
        projectId,
        boardId: board.id,
        title,
        description: String(body.description || "").trim(),
        status: board.columns.includes(body.status) ? body.status : board.columns[0],
        priority: String(body.priority || "Medium"),
        assigneeId: body.assigneeId || user.id,
        dueDate: String(body.dueDate || ""),
        createdBy: user.id,
        createdAt: now,
        updatedAt: now
      };
      db.tasks.push(task);
      notifyProject(db, project, user.id, "task_created", `${user.name} created task "${task.title}"`, task.id);
      writeDb(db);
      return send(res, 201, { task });
    }

    const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskMatch && req.method === "PATCH") {
      const taskId = taskMatch[1];
      const body = await getBody(req);
      const db = readDb();
      const task = db.tasks.find(item => item.id === taskId);
      const project = task && db.projects.find(item => item.id === task.projectId);
      if (!task || !canAccessProject(project, user)) return send(res, 404, { error: "Task not found" });
      ["title", "description", "status", "priority", "assigneeId", "dueDate"].forEach(key => {
        if (Object.prototype.hasOwnProperty.call(body, key)) task[key] = String(body[key] || "").trim();
      });
      task.updatedAt = new Date().toISOString();
      notifyProject(db, project, user.id, "task_updated", `${user.name} updated "${task.title}"`, task.id);
      writeDb(db);
      return send(res, 200, { task });
    }

    const commentsMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/comments$/);
    if (commentsMatch && req.method === "GET") {
      const taskId = commentsMatch[1];
      const db = readDb();
      const task = db.tasks.find(item => item.id === taskId);
      const project = task && db.projects.find(item => item.id === task.projectId);
      if (!task || !canAccessProject(project, user)) return send(res, 404, { error: "Task not found" });
      const comments = db.comments
        .filter(comment => comment.taskId === taskId)
        .map(comment => ({ ...comment, author: safeUser(db.users.find(item => item.id === comment.userId)) }));
      return send(res, 200, { comments });
    }

    if (commentsMatch && req.method === "POST") {
      const taskId = commentsMatch[1];
      const body = await getBody(req);
      const text = String(body.text || "").trim();
      if (!text) return send(res, 400, { error: "Comment text is required" });
      const db = readDb();
      const task = db.tasks.find(item => item.id === taskId);
      const project = task && db.projects.find(item => item.id === task.projectId);
      if (!task || !canAccessProject(project, user)) return send(res, 404, { error: "Task not found" });
      const comment = { id: id(), taskId, projectId: project.id, userId: user.id, text, createdAt: new Date().toISOString() };
      db.comments.push(comment);
      notifyProject(db, project, user.id, "comment_created", `${user.name} commented on "${task.title}"`, task.id);
      writeDb(db);
      return send(res, 201, { comment: { ...comment, author: safeUser(user) } });
    }

    if (req.method === "PATCH" && url.pathname === "/api/notifications/read") {
      const db = readDb();
      db.notifications.forEach(item => {
        if (item.userId === user.id) item.read = true;
      });
      writeDb(db);
      return send(res, 200, { ok: true });
    }

    notFound(res);
  } catch (error) {
    send(res, 500, { error: error.message || "Server error" });
  }
}

function serveStatic(req, res, url) {
  let filePath = decodeURIComponent(url.pathname);
  if (filePath === "/") filePath = "/index.html";
  const target = path.normalize(path.join(PUBLIC_DIR, filePath));
  const publicRoot = PUBLIC_DIR.endsWith(path.sep) ? PUBLIC_DIR : `${PUBLIC_DIR}${path.sep}`;
  if (!target.startsWith(publicRoot)) return notFound(res);
  fs.readFile(target, (error, content) => {
    if (error) return notFound(res);
    const ext = path.extname(target);
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
  serveStatic(req, res, url);
});

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== "/ws") return socket.destroy();
  const token = url.searchParams.get("token");
  const payload = verifyToken(token);
  if (!payload) return socket.destroy();
  const db = readDb();
  const user = db.users.find(item => item.id === payload.sub);
  if (!user) return socket.destroy();
  const accept = crypto
    .createHash("sha1")
    .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    ""
  ].join("\r\n"));
  const projectIds = new Set(db.projects.filter(project => canAccessProject(project, user)).map(project => project.id));
  sockets.set(socket, { socket, userId: user.id, projectIds });
  socket.on("close", () => sockets.delete(socket));
  socket.on("end", () => sockets.delete(socket));
});

function encodeWebSocketFrame(text) {
  const payload = Buffer.from(text);
  const length = payload.length;
  if (length < 126) return Buffer.concat([Buffer.from([0x81, length]), payload]);
  if (length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, payload]);
}

ensureDb();
server.listen(PORT, () => {
  console.log(`Collab Board running at http://localhost:${PORT}`);
});
