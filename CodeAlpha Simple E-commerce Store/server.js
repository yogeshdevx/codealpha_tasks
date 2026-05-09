const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, "data", "db.json");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

async function readDb() {
  const raw = await fs.readFile(DB_PATH, "utf8");
  return JSON.parse(raw);
}

async function writeDb(db) {
  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2));
}

function publicUser(user) {
  if (!user) return null;
  return { id: user.id, name: user.name, email: user.email };
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((cookie) => cookie.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key, decodeURIComponent(value)])
  );
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, savedHash] = stored.split(":");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(savedHash, "hex"));
}

async function currentUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  if (!cookies.session) return null;

  const db = await readDb();
  const session = db.sessions.find((item) => item.token === cookies.session);
  if (!session) return null;

  return db.users.find((user) => user.id === session.userId) || null;
}

function requireFields(body, fields) {
  const missing = fields.filter((field) => !String(body[field] || "").trim());
  if (missing.length) {
    const error = new Error(`Missing required field: ${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

app.get("/api/products", async (_req, res) => {
  const db = await readDb();
  res.json(db.products);
});

app.get("/api/products/:id", async (req, res) => {
  const db = await readDb();
  const product = db.products.find((item) => item.id === req.params.id);
  if (!product) return res.status(404).json({ message: "Product not found" });
  res.json(product);
});

app.get("/api/me", async (req, res) => {
  res.json({ user: publicUser(await currentUser(req)) });
});

app.post("/api/register", async (req, res, next) => {
  try {
    requireFields(req.body, ["name", "email", "password"]);
    const db = await readDb();
    const email = req.body.email.trim().toLowerCase();

    if (db.users.some((user) => user.email === email)) {
      return res.status(409).json({ message: "Email is already registered" });
    }

    const user = {
      id: crypto.randomUUID(),
      name: req.body.name.trim(),
      email,
      passwordHash: hashPassword(req.body.password)
    };
    const token = crypto.randomBytes(32).toString("hex");

    db.users.push(user);
    db.sessions.push({ token, userId: user.id, createdAt: new Date().toISOString() });
    await writeDb(db);

    res.cookie("session", token, { httpOnly: true, sameSite: "lax" });
    res.status(201).json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/login", async (req, res, next) => {
  try {
    requireFields(req.body, ["email", "password"]);
    const db = await readDb();
    const user = db.users.find((item) => item.email === req.body.email.trim().toLowerCase());

    if (!user || !verifyPassword(req.body.password, user.passwordHash)) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const token = crypto.randomBytes(32).toString("hex");
    db.sessions.push({ token, userId: user.id, createdAt: new Date().toISOString() });
    await writeDb(db);

    res.cookie("session", token, { httpOnly: true, sameSite: "lax" });
    res.json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/logout", async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const db = await readDb();
  db.sessions = db.sessions.filter((session) => session.token !== cookies.session);
  await writeDb(db);
  res.clearCookie("session");
  res.json({ ok: true });
});

app.get("/api/orders", async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ message: "Please log in to view orders" });

  const db = await readDb();
  const orders = db.orders.filter((order) => order.userId === user.id);
  res.json(orders);
});

app.post("/api/orders", async (req, res, next) => {
  try {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ message: "Please log in before checkout" });

    requireFields(req.body, ["name", "address", "city", "payment"]);

    if (!Array.isArray(req.body.items) || req.body.items.length === 0) {
      return res.status(400).json({ message: "Your cart is empty" });
    }

    const db = await readDb();
    const items = req.body.items.map((cartItem) => {
      const product = db.products.find((item) => item.id === cartItem.productId);
      const quantity = Math.max(1, Number(cartItem.quantity) || 1);
      if (!product) {
        const error = new Error("One of the cart products no longer exists");
        error.status = 400;
        throw error;
      }
      return {
        productId: product.id,
        name: product.name,
        price: product.price,
        quantity,
        lineTotal: Number((product.price * quantity).toFixed(2))
      };
    });

    const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
    const shipping = subtotal > 75 ? 0 : 7.99;
    const total = Number((subtotal + shipping).toFixed(2));
    const order = {
      id: crypto.randomUUID(),
      userId: user.id,
      items,
      shippingAddress: {
        name: req.body.name.trim(),
        address: req.body.address.trim(),
        city: req.body.city.trim()
      },
      payment: req.body.payment,
      subtotal: Number(subtotal.toFixed(2)),
      shipping,
      total,
      status: "Processing",
      createdAt: new Date().toISOString()
    };

    db.orders.unshift(order);
    await writeDb(db);

    res.status(201).json(order);
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  res.status(error.status || 500).json({ message: error.message || "Server error" });
});

app.listen(PORT, () => {
  console.log(`Store running at http://localhost:${PORT}`);
});
