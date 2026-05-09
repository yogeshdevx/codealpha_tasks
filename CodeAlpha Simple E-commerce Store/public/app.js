const app = document.querySelector("#app");
const cartCount = document.querySelector("#cart-count");
const authButton = document.querySelector("#auth-button");
const authDialog = document.querySelector("#auth-dialog");
const authForm = document.querySelector("#auth-form");
const authTitle = document.querySelector("#auth-title");
const authName = document.querySelector("#auth-name");
const authMessage = document.querySelector("#auth-message");
const loginTab = document.querySelector("#login-tab");
const registerTab = document.querySelector("#register-tab");

let products = [];
let user = null;
let authMode = "login";

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function getCart() {
  return JSON.parse(localStorage.getItem("marketlane-cart") || "[]");
}

function saveCart(cart) {
  localStorage.setItem("marketlane-cart", JSON.stringify(cart));
  renderCartCount();
}

function renderCartCount() {
  const total = getCart().reduce((sum, item) => sum + item.quantity, 0);
  cartCount.textContent = total;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "Something went wrong");
  return data;
}

function setAuthMode(mode) {
  authMode = mode;
  authTitle.textContent = mode === "login" ? "Login" : "Create account";
  authName.parentElement.style.display = mode === "login" ? "none" : "grid";
  authName.required = mode === "register";
  loginTab.classList.toggle("active", mode === "login");
  registerTab.classList.toggle("active", mode === "register");
  authMessage.textContent = "";
}

function openAuth(mode = "login") {
  setAuthMode(mode);
  authDialog.showModal();
}

function updateAuthButton() {
  authButton.textContent = user ? `Logout (${user.name.split(" ")[0]})` : "Login";
}

function addToCart(productId, quantity = 1) {
  const cart = getCart();
  const existing = cart.find((item) => item.productId === productId);
  if (existing) existing.quantity += quantity;
  else cart.push({ productId, quantity });
  saveCart(cart);
}

function productById(id) {
  return products.find((product) => product.id === id);
}

function money(value) {
  return currency.format(value);
}

function productCard(product) {
  const template = document.querySelector("#product-card-template");
  const node = template.content.firstElementChild.cloneNode(true);
  const link = node.querySelector(".product-image-link");
  const image = node.querySelector("img");
  const eyebrow = node.querySelector(".eyebrow");
  const title = node.querySelector("h3");
  const description = node.querySelector(".muted");
  const price = node.querySelector("strong");
  const button = node.querySelector("button");

  link.href = `#/product/${product.id}`;
  image.src = product.image;
  image.alt = product.name;
  eyebrow.textContent = product.category;
  title.textContent = product.name;
  description.textContent = `${product.rating} stars - ${product.stock} in stock`;
  price.textContent = money(product.price);
  button.addEventListener("click", () => addToCart(product.id));

  return node;
}

function renderProducts() {
  app.innerHTML = `
    <section class="hero">
      <div>
        <p class="eyebrow">Simple E-commerce Store</p>
        <h1>Useful goods, ready for checkout.</h1>
        <p>Browse products, open details, add items to your cart, create an account, and place an order through the built-in Express backend.</p>
      </div>
      <div class="hero-image" aria-hidden="true"></div>
    </section>
    <section>
      <div class="toolbar">
        <input class="search-box" id="search" placeholder="Search products" />
        <select id="category">
          <option value="">All categories</option>
          ${[...new Set(products.map((product) => product.category))].map((category) => `<option value="${category}">${category}</option>`).join("")}
        </select>
      </div>
      <div class="product-grid" id="product-grid"></div>
    </section>
  `;

  const grid = document.querySelector("#product-grid");
  const search = document.querySelector("#search");
  const category = document.querySelector("#category");

  function draw() {
    const query = search.value.trim().toLowerCase();
    const filtered = products.filter((product) => {
      const matchesQuery = product.name.toLowerCase().includes(query) || product.description.toLowerCase().includes(query);
      const matchesCategory = !category.value || product.category === category.value;
      return matchesQuery && matchesCategory;
    });
    grid.replaceChildren(...filtered.map(productCard));
  }

  search.addEventListener("input", draw);
  category.addEventListener("change", draw);
  draw();
}

function renderProductDetail(id) {
  const product = productById(id);
  if (!product) {
    app.innerHTML = `<section class="empty-state"><h1>Product not found</h1><a class="secondary-button" href="#/">Back to products</a></section>`;
    return;
  }

  app.innerHTML = `
    <section class="detail-layout">
      <div class="detail-media">
        <img src="${product.image}" alt="${product.name}" />
      </div>
      <div class="detail-info">
        <p class="eyebrow">${product.category}</p>
        <h1>${product.name}</h1>
        <p class="muted">${product.description}</p>
        <p class="price">${money(product.price)}</p>
        <p class="muted">${product.rating} stars - ${product.stock} available</p>
        <button class="primary-button" id="detail-add" type="button">Add to cart</button>
      </div>
    </section>
  `;
  document.querySelector("#detail-add").addEventListener("click", () => addToCart(product.id));
}

function cartTotals() {
  const items = getCart()
    .map((item) => ({ ...item, product: productById(item.productId) }))
    .filter((item) => item.product);
  const subtotal = items.reduce((sum, item) => sum + item.product.price * item.quantity, 0);
  const shipping = subtotal > 75 || subtotal === 0 ? 0 : 7.99;
  return { items, subtotal, shipping, total: subtotal + shipping };
}

function renderCart() {
  const { items, subtotal, shipping, total } = cartTotals();
  if (!items.length) {
    app.innerHTML = `<section class="empty-state"><h1>Your cart is empty</h1><p class="muted">Add a product to start an order.</p><a class="primary-button" href="#/">Shop products</a></section>`;
    return;
  }

  app.innerHTML = `
    <section class="page-title">
      <h1>Shopping cart</h1>
      <p>Review your items and submit the checkout form to create an order.</p>
    </section>
    <section class="cart-layout">
      <div>
        <div class="cart-list" id="cart-list"></div>
        <form class="checkout-form" id="checkout-form">
          <h2>Checkout</h2>
          <label>Full name<input name="name" required value="${user?.name || ""}" /></label>
          <label>Address<textarea name="address" required></textarea></label>
          <label>City<input name="city" required /></label>
          <label>Payment method
            <select name="payment">
              <option value="Card">Card</option>
              <option value="Cash on delivery">Cash on delivery</option>
            </select>
          </label>
          <p class="form-message" id="checkout-message"></p>
          <button class="primary-button" type="submit">${user ? "Place order" : "Login to place order"}</button>
        </form>
      </div>
      <aside class="summary-panel">
        <h2>Summary</h2>
        <div class="summary-row"><span>Subtotal</span><strong>${money(subtotal)}</strong></div>
        <div class="summary-row"><span>Shipping</span><strong>${shipping ? money(shipping) : "Free"}</strong></div>
        <div class="summary-row total"><span>Total</span><strong>${money(total)}</strong></div>
      </aside>
    </section>
  `;

  const cartList = document.querySelector("#cart-list");
  cartList.replaceChildren(...items.map((item) => cartItem(item)));

  document.querySelector("#checkout-form").addEventListener("submit", submitOrder);
}

function cartItem(item) {
  const row = document.createElement("article");
  row.className = "cart-item";
  row.innerHTML = `
    <img src="${item.product.image}" alt="${item.product.name}" />
    <div>
      <div class="cart-row">
        <div>
          <h3>${item.product.name}</h3>
          <p class="muted">${money(item.product.price)} each</p>
        </div>
        <strong>${money(item.product.price * item.quantity)}</strong>
      </div>
      <div class="cart-row">
        <div class="quantity-controls">
          <button class="quantity-button" data-action="decrease" type="button">-</button>
          <strong>${item.quantity}</strong>
          <button class="quantity-button" data-action="increase" type="button">+</button>
        </div>
        <button class="remove-button" data-action="remove" type="button">Remove</button>
      </div>
    </div>
  `;

  row.addEventListener("click", (event) => {
    const action = event.target.dataset.action;
    if (!action) return;
    const cart = getCart();
    const entry = cart.find((cartEntry) => cartEntry.productId === item.productId);
    if (action === "increase") entry.quantity += 1;
    if (action === "decrease") entry.quantity -= 1;
    const updated = action === "remove" ? cart.filter((cartEntry) => cartEntry.productId !== item.productId) : cart.filter((cartEntry) => cartEntry.quantity > 0);
    saveCart(updated);
    renderCart();
  });

  return row;
}

async function submitOrder(event) {
  event.preventDefault();
  if (!user) {
    openAuth("login");
    return;
  }

  const form = new FormData(event.currentTarget);
  const message = document.querySelector("#checkout-message");
  try {
    const order = await api("/api/orders", {
      method: "POST",
      body: JSON.stringify({
        name: form.get("name"),
        address: form.get("address"),
        city: form.get("city"),
        payment: form.get("payment"),
        items: getCart()
      })
    });
    saveCart([]);
    location.hash = `#/orders?placed=${order.id}`;
  } catch (error) {
    message.textContent = error.message;
  }
}

async function renderOrders() {
  if (!user) {
    app.innerHTML = `<section class="empty-state"><h1>Login required</h1><p class="muted">Create an account or login to view orders.</p><button class="primary-button" id="orders-login" type="button">Login</button></section>`;
    document.querySelector("#orders-login").addEventListener("click", () => openAuth("login"));
    return;
  }

  const orders = await api("/api/orders");
  app.innerHTML = `
    <section class="page-title">
      <h1>Your orders</h1>
      <p>Orders placed through checkout are saved in the backend database.</p>
    </section>
    <section class="order-list" id="order-list"></section>
  `;

  const list = document.querySelector("#order-list");
  if (!orders.length) {
    list.innerHTML = `<div class="empty-state"><h2>No orders yet</h2><a class="primary-button" href="#/">Start shopping</a></div>`;
    return;
  }

  list.replaceChildren(
    ...orders.map((order) => {
      const article = document.createElement("article");
      article.className = "order-card";
      article.innerHTML = `
        <div class="cart-row">
          <div>
            <p class="eyebrow">${order.status}</p>
            <h2>Order ${order.id.slice(0, 8)}</h2>
            <p class="muted">${new Date(order.createdAt).toLocaleString()}</p>
          </div>
          <strong>${money(order.total)}</strong>
        </div>
        <ul>${order.items.map((item) => `<li>${item.quantity} x ${item.name} - ${money(item.lineTotal)}</li>`).join("")}</ul>
        <p class="muted">Ship to ${order.shippingAddress.name}, ${order.shippingAddress.address}, ${order.shippingAddress.city}</p>
      `;
      return article;
    })
  );
}

async function route() {
  const [path, id] = location.hash.replace(/^#\/?/, "").split("/");
  if (!path) renderProducts();
  else if (path === "product") renderProductDetail(id);
  else if (path.startsWith("cart")) renderCart();
  else if (path.startsWith("orders")) await renderOrders();
  else renderProducts();
  scrollTo({ top: 0, behavior: "smooth" });
}

authButton.addEventListener("click", async () => {
  if (!user) {
    openAuth("login");
    return;
  }
  await api("/api/logout", { method: "POST" });
  user = null;
  updateAuthButton();
  route();
});

document.querySelector(".close-dialog").addEventListener("click", () => authDialog.close());
loginTab.addEventListener("click", () => setAuthMode("login"));
registerTab.addEventListener("click", () => setAuthMode("register"));

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(authForm);
  try {
    const result = await api(authMode === "login" ? "/api/login" : "/api/register", {
      method: "POST",
      body: JSON.stringify({
        name: form.get("name"),
        email: form.get("email"),
        password: form.get("password")
      })
    });
    user = result.user;
    authDialog.close();
    authForm.reset();
    updateAuthButton();
    route();
  } catch (error) {
    authMessage.textContent = error.message;
  }
});

async function init() {
  products = await api("/api/products");
  user = (await api("/api/me")).user;
  updateAuthButton();
  renderCartCount();
  setAuthMode("login");
  window.addEventListener("hashchange", route);
  route();
}

init();
