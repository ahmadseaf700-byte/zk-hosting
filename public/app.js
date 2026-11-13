const authScreen = document.getElementById("auth-screen");
const dashboard = document.getElementById("dashboard");
const authForm = document.getElementById("auth-form");
const authMessage = document.getElementById("auth-message");
const authSubmit = document.getElementById("auth-submit");
const loginTab = document.getElementById("login-tab");
const registerTab = document.getElementById("register-tab");
const list = document.getElementById("server-list");
const count = document.getElementById("server-count");
const form = document.getElementById("create-form");
const message = document.getElementById("form-message");
let authMode = "login";

function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === "register";
  loginTab.classList.toggle("active", !registering);
  registerTab.classList.toggle("active", registering);
  authSubmit.textContent = registering ? "إنشاء الحساب" : "تسجيل الدخول";
  document.getElementById("auth-password").autocomplete = registering ? "new-password" : "current-password";
  authMessage.textContent = "";
}
loginTab.addEventListener("click", () => setAuthMode("login"));
registerTab.addEventListener("click", () => setAuthMode("register"));

function showDashboard(user) {
  authScreen.hidden = true;
  dashboard.hidden = false;
  document.getElementById("signed-in-as").textContent = user.email;
  checkHealth();
  loadServers();
}

function showAuth() {
  dashboard.hidden = true;
  authScreen.hidden = false;
}

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && path.startsWith("/api/servers")) showAuth();
    throw new Error(data.error || "حدث خطأ غير متوقع.");
  }
  return data;
}

authForm.addEventListener("submit", async event => {
  event.preventDefault();
  authSubmit.disabled = true;
  authMessage.textContent = authMode === "register" ? "جارٍ إنشاء حسابك..." : "جارٍ تسجيل الدخول...";
  const payload = Object.fromEntries(new FormData(authForm).entries());
  try {
    const data = await api(`/api/auth/${authMode}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
    });
    authForm.reset();
    showDashboard(data.user);
  } catch (error) {
    authMessage.textContent = error.message;
  } finally {
    authSubmit.disabled = false;
  }
});

document.getElementById("logout-button").addEventListener("click", async () => {
  try { await api("/api/auth/logout", { method: "POST" }); } catch {}
  showAuth();
  setAuthMode("login");
});

async function loadServers() {
  try {
    const data = await api("/api/servers");
    const servers = data.servers || [];
    count.textContent = `${servers.length} سيرفر`;
    if (!servers.length) {
      list.innerHTML = '<div class="empty-state"><div class="empty-icon">▧</div><strong>ما عندك سيرفرات لسه</strong><p>أنشئ أول سيرفر من النموذج.</p></div>';
      return;
    }
    list.innerHTML = servers.map(server => `
      <article class="server-item">
        <div><div class="server-name">${escapeHtml(server.name)}</div>
        <div class="server-meta">${server.edition === "java" ? "Java" : "Bedrock"} · ${escapeHtml(server.software)} · ${escapeHtml(server.version)}</div></div>
        <span class="offline">بانتظار جهاز الاستضافة</span>
      </article>`).join("");
  } catch (error) {
    list.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

async function checkHealth() {
  const status = document.getElementById("api-status");
  try {
    await api("/api/health");
    status.textContent = "الخادم متصل ويعمل";
  } catch {
    status.textContent = "تعذر الاتصال بالخادم";
  }
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  const button = form.querySelector("button");
  button.disabled = true;
  message.textContent = "جارٍ إنشاء إعدادات السيرفر...";
  const payload = Object.fromEntries(new FormData(form).entries());
  try {
    await api("/api/servers", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
    });
    message.textContent = "تم إنشاء إعدادات السيرفر بنجاح. التشغيل الفعلي سيُفعّل بعد ربط جهاز الاستضافة.";
    form.reset();
    document.getElementById("version").value = "1.21.11";
    await loadServers();
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

(async function init() {
  try {
    const data = await api("/api/auth/me");
    showDashboard(data.user);
  } catch {
    showAuth();
  }
})();
