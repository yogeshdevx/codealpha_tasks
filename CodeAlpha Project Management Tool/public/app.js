const state = {
  token: localStorage.getItem("collab.token"),
  user: JSON.parse(localStorage.getItem("collab.user") || "null"),
  users: [],
  projects: [],
  activeProjectId: localStorage.getItem("collab.project"),
  selectedTask: null,
  comments: [],
  notifications: [],
  toasts: []
};

const app = document.querySelector("#app");
let socket;

const api = async (path, options = {}) => {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
};

function saveSession(token, user) {
  state.token = token;
  state.user = user;
  localStorage.setItem("collab.token", token);
  localStorage.setItem("collab.user", JSON.stringify(user));
}

function logout() {
  localStorage.removeItem("collab.token");
  localStorage.removeItem("collab.user");
  localStorage.removeItem("collab.project");
  if (socket) socket.close();
  Object.assign(state, { token: null, user: null, projects: [], selectedTask: null, comments: [] });
  renderAuth();
}

function html(strings, ...values) {
  return strings.map((string, index) => string + (values[index] ?? "")).join("");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[char]));
}

function getActiveProject() {
  return state.projects.find(project => project.id === state.activeProjectId) || state.projects[0];
}

function userName(id) {
  return state.users.find(user => user.id === id)?.name || "Unassigned";
}

function connectSocket() {
  if (!state.token || socket?.readyState === WebSocket.OPEN) return;
  socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?token=${encodeURIComponent(state.token)}`);
  socket.onmessage = async event => {
    const payload = JSON.parse(event.data);
    state.toasts.unshift(payload.message || "Board updated");
    state.toasts = state.toasts.slice(0, 3);
    renderToasts();
    await loadData(false);
  };
}

async function loadData(shouldRender = true) {
  const [me, users, projects] = await Promise.all([
    api("/api/me"),
    api("/api/users"),
    api("/api/projects")
  ]);
  state.user = me.user;
  state.users = users.users;
  state.notifications = me.notifications;
  state.projects = projects.projects;
  if (!state.activeProjectId && state.projects[0]) state.activeProjectId = state.projects[0].id;
  if (state.activeProjectId) localStorage.setItem("collab.project", state.activeProjectId);
  if (shouldRender) renderApp();
  connectSocket();
}

function renderAuth(error = "") {
  app.innerHTML = html`
    <section class="auth-page">
      <div class="auth-card">
        <div class="auth-copy">
          <div class="brand"><span class="mark">✓</span> Collab Board</div>
          <h1>Plan work with your team.</h1>
          <p>Create group projects, assign task cards, discuss work where it happens, and see updates live.</p>
          <p>Demo account: <strong>demo@example.com</strong> / <strong>demo123</strong></p>
        </div>
        <form class="auth-form form-grid" id="auth-form">
          <h2>Sign in or create account</h2>
          ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
          <label class="field">
            <span>Name</span>
            <input name="name" placeholder="Required for registration">
          </label>
          <label class="field">
            <span>Email</span>
            <input name="email" type="email" value="demo@example.com" required>
          </label>
          <label class="field">
            <span>Password</span>
            <input name="password" type="password" value="demo123" minlength="6" required>
          </label>
          <div class="actions">
            <button class="btn primary" name="mode" value="login">Log in</button>
            <button class="btn" name="mode" value="register">Register</button>
          </div>
        </form>
      </div>
    </section>
  `;

  document.querySelector("#auth-form").addEventListener("submit", async event => {
    event.preventDefault();
    const submitter = event.submitter?.value || "login";
    const form = new FormData(event.currentTarget);
    try {
      const data = await api(`/api/auth/${submitter}`, {
        method: "POST",
        body: JSON.stringify({
          name: form.get("name"),
          email: form.get("email"),
          password: form.get("password")
        })
      });
      saveSession(data.token, data.user);
      await loadData();
    } catch (err) {
      renderAuth(err.message);
    }
  });
}

function renderApp() {
  const project = getActiveProject();
  if (!project) return renderEmptyWorkspace();
  const board = project.boards[0];
  app.innerHTML = html`
    <section class="shell">
      <aside class="sidebar">
        <div class="brand"><span class="mark">✓</span> Collab Board</div>
        <div class="side-section">
          <h2>Projects</h2>
          <div class="project-list">
            ${state.projects.map(item => `
              <button class="project-tab ${item.id === project.id ? "active" : ""}" data-project="${item.id}">
                ${escapeHtml(item.name)}
              </button>
            `).join("")}
          </div>
        </div>
        <form class="panel form-grid" id="project-form">
          <h2>New Project</h2>
          <label class="field"><span>Name</span><input name="name" required></label>
          <label class="field"><span>Description</span><textarea name="description"></textarea></label>
          <button class="btn primary">Create Project</button>
        </form>
      </aside>
      <section class="main">
        <header class="topbar">
          <div class="title-stack">
            <h1>${escapeHtml(project.name)}</h1>
            <p>${escapeHtml(project.description || "No description yet")} · ${project.members.length} member${project.members.length === 1 ? "" : "s"}</p>
          </div>
          <div class="actions">
            <button class="btn" id="mark-read">Notifications ${state.notifications.filter(item => !item.read).length}</button>
            <button class="btn ghost" id="logout">Log out</button>
          </div>
        </header>
        <div class="board">
          ${board.columns.map(column => renderColumn(project, column)).join("")}
        </div>
      </section>
    </section>
    ${state.selectedTask ? renderDrawer(project) : ""}
    <div class="notification-tray" id="toasts"></div>
  `;

  bindAppEvents(project, board);
  renderToasts();
}

function renderEmptyWorkspace() {
  app.innerHTML = html`
    <section class="auth-page">
      <form class="panel form-grid" id="project-form">
        <h1>Create your first project</h1>
        <label class="field"><span>Name</span><input name="name" required></label>
        <label class="field"><span>Description</span><textarea name="description"></textarea></label>
        <button class="btn primary">Create Project</button>
        <button class="btn ghost" type="button" id="logout">Log out</button>
      </form>
    </section>
  `;
  bindProjectForm();
  document.querySelector("#logout").addEventListener("click", logout);
}

function renderColumn(project, column) {
  const tasks = project.tasks.filter(task => task.status === column);
  return html`
    <section class="column">
      <div class="column-header">
        <span>${escapeHtml(column)}</span>
        <span class="count">${tasks.length}</span>
      </div>
      <div class="cards">
        ${tasks.map(renderTaskCard).join("") || `<div class="empty">No tasks</div>`}
        <button class="btn" data-add-task="${escapeHtml(column)}">+ Task</button>
      </div>
    </section>
  `;
}

function renderTaskCard(task) {
  return html`
    <button class="task-card" data-task="${task.id}">
      <div class="task-title">${escapeHtml(task.title)}</div>
      <div class="meta">
        <span class="pill ${escapeHtml(task.priority)}">${escapeHtml(task.priority)}</span>
        <span class="pill">${escapeHtml(userName(task.assigneeId))}</span>
        ${task.dueDate ? `<span class="pill">${escapeHtml(task.dueDate)}</span>` : ""}
      </div>
    </button>
  `;
}

function renderDrawer(project) {
  const task = state.selectedTask;
  const board = project.boards[0];
  return html`
    <div class="drawer-backdrop">
      <aside class="drawer">
        <div class="drawer-head">
          <div>
            <h2>Task Card</h2>
            <h1>${escapeHtml(task.id ? "Edit Task" : "New Task")}</h1>
          </div>
          <button class="btn" id="close-drawer">Close</button>
        </div>
        <form class="form-grid" id="task-form">
          <label class="field"><span>Title</span><input name="title" value="${escapeHtml(task.title)}" required></label>
          <label class="field"><span>Description</span><textarea name="description">${escapeHtml(task.description)}</textarea></label>
          <label class="field">
            <span>Status</span>
            <select name="status">${board.columns.map(column => `<option ${column === task.status ? "selected" : ""}>${escapeHtml(column)}</option>`).join("")}</select>
          </label>
          <label class="field">
            <span>Assignee</span>
            <select name="assigneeId">${project.members.map(member => `<option value="${member.id}" ${member.id === task.assigneeId ? "selected" : ""}>${escapeHtml(member.name)}</option>`).join("")}</select>
          </label>
          <label class="field">
            <span>Priority</span>
            <select name="priority">${["Low", "Medium", "High"].map(priority => `<option ${priority === task.priority ? "selected" : ""}>${priority}</option>`).join("")}</select>
          </label>
          <label class="field"><span>Due Date</span><input name="dueDate" type="date" value="${escapeHtml(task.dueDate)}"></label>
          <button class="btn primary">${task.id ? "Save Task" : "Create Task"}</button>
        </form>
        ${task.id ? renderComments() : ""}
      </aside>
    </div>
  `;
}

function renderComments() {
  return html`
    <section class="panel" style="margin-top:16px">
      <h2>Comments</h2>
      <div class="comments">
        ${state.comments.map(comment => `
          <div class="comment">
            <strong>${escapeHtml(comment.author?.name || "User")}</strong>
            <div>${escapeHtml(comment.text)}</div>
          </div>
        `).join("") || `<div class="empty">No comments yet</div>`}
      </div>
      <form class="form-grid" id="comment-form">
        <label class="field"><span>Add Comment</span><textarea name="text" required></textarea></label>
        <button class="btn primary">Send Comment</button>
      </form>
    </section>
  `;
}

function bindAppEvents(project, board) {
  document.querySelectorAll("[data-project]").forEach(button => {
    button.addEventListener("click", () => {
      state.activeProjectId = button.dataset.project;
      state.selectedTask = null;
      localStorage.setItem("collab.project", state.activeProjectId);
      renderApp();
    });
  });
  document.querySelectorAll("[data-add-task]").forEach(button => {
    button.addEventListener("click", () => {
      state.selectedTask = {
        title: "",
        description: "",
        status: button.dataset.addTask,
        priority: "Medium",
        assigneeId: project.members[0]?.id || state.user.id,
        dueDate: ""
      };
      state.comments = [];
      renderApp();
    });
  });
  document.querySelectorAll("[data-task]").forEach(button => {
    button.addEventListener("click", async () => {
      state.selectedTask = project.tasks.find(task => task.id === button.dataset.task);
      const data = await api(`/api/tasks/${state.selectedTask.id}/comments`);
      state.comments = data.comments;
      renderApp();
    });
  });
  document.querySelector("#logout").addEventListener("click", logout);
  document.querySelector("#mark-read").addEventListener("click", async () => {
    await api("/api/notifications/read", { method: "PATCH", body: "{}" });
    await loadData();
  });
  bindProjectForm();
  bindTaskDrawer(project);
}

function bindProjectForm() {
  document.querySelector("#project-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const data = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: form.get("name"), description: form.get("description") })
    });
    state.activeProjectId = data.project.id;
    await loadData();
  });
}

function bindTaskDrawer(project) {
  if (!state.selectedTask) return;
  document.querySelector("#close-drawer").addEventListener("click", () => {
    state.selectedTask = null;
    state.comments = [];
    renderApp();
  });
  document.querySelector(".drawer-backdrop").addEventListener("click", event => {
    if (event.target.classList.contains("drawer-backdrop")) {
      state.selectedTask = null;
      state.comments = [];
      renderApp();
    }
  });
  document.querySelector("#task-form").addEventListener("submit", async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(form.entries());
    if (state.selectedTask.id) {
      await api(`/api/tasks/${state.selectedTask.id}`, { method: "PATCH", body: JSON.stringify(payload) });
    } else {
      await api(`/api/projects/${project.id}/tasks`, { method: "POST", body: JSON.stringify(payload) });
    }
    state.selectedTask = null;
    await loadData();
  });
  document.querySelector("#comment-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await api(`/api/tasks/${state.selectedTask.id}/comments`, {
      method: "POST",
      body: JSON.stringify({ text: form.get("text") })
    });
    const data = await api(`/api/tasks/${state.selectedTask.id}/comments`);
    state.comments = data.comments;
    event.currentTarget.reset();
    renderApp();
  });
}

function renderToasts() {
  const tray = document.querySelector("#toasts");
  if (!tray) return;
  tray.innerHTML = state.toasts.map(message => `<div class="toast">${escapeHtml(message)}</div>`).join("");
  window.clearTimeout(renderToasts.timer);
  renderToasts.timer = window.setTimeout(() => {
    state.toasts = [];
    if (tray) tray.innerHTML = "";
  }, 4200);
}

if (state.token) {
  loadData().catch(() => {
    logout();
  });
} else {
  renderAuth();
}
