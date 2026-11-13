const list = document.getElementById("server-list");
const count = document.getElementById("server-count");
const form = document.getElementById("create-form");
const message = document.getElementById("form-message");

async function loadServers() {
  try {
    const response = await fetch("/api/servers");
    const data = await response.json();
    const servers = data.servers || [];
    count.textContent = `${servers.length} سيرفر`;
    if (!servers.length) {
      list.innerHTML = '<div class="empty-state"><div class="empty-icon">▧</div><strong>ما عندك سيرفرات لسه</strong><p>أنشئ أول سيرفر من النموذج.</p></div>';
      return;
    }
    list.innerHTML = servers.map(server => `
      <article class="server-item">
        <div><div class="server-name">${escapeHtml(server.name)}</div>
        <div class="server-meta">${server.edition === "java" ? "Java" : "Bedrock"} · ${escapeHtml(server.version)}</div></div>
        <span class="offline">غير متصل</span>
      </article>`).join("");
  } catch {
    list.innerHTML = '<div class="empty-state">تعذر تحميل السيرفرات.</div>';
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
    const response = await fetch("/api/health");
    if (!response.ok) throw new Error("offline");
    status.textContent = "الخادم متصل ويعمل";
  } catch {
    status.textContent = "تعذر الاتصال بالخادم";
  }
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  const button = form.querySelector("button");
  button.disabled = true;
  message.textContent = "جارٍ إنشاء السيرفر...";
  const payload = Object.fromEntries(new FormData(form).entries());
  try {
    const response = await fetch("/api/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "حدث خطأ.");
    message.textContent = "تمت إضافة السيرفر إلى القائمة التجريبية.";
    form.reset();
    document.getElementById("version").value = "1.21.11";
    await loadServers();
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

checkHealth();
loadServers();
