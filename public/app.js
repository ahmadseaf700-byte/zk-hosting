const $ = (id) => document.getElementById(id);
const authScreen = $("auth-screen"), dashboard = $("dashboard");
const authForm = $("auth-form"), authMessage = $("auth-message"), authSubmit = $("auth-submit");
const loginTab = $("login-tab"), registerTab = $("register-tab");
const list = $("server-list"), wizardForm = $("wizard-form");
let authMode = "login", currentStep = 1, subdomainTimer = null, subdomainAvailable = false, cachedServers = [];
let commandHistory = [], historyIndex = 0;

function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === "register";
  loginTab.classList.toggle("active", !registering);
  registerTab.classList.toggle("active", registering);
  authSubmit.textContent = registering ? "إنشاء الحساب" : "تسجيل الدخول";
  $("auth-password").autocomplete = registering ? "new-password" : "current-password";
  authMessage.textContent = "";
}
loginTab.addEventListener("click", () => setAuthMode("login"));
registerTab.addEventListener("click", () => setAuthMode("register"));

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && path.startsWith("/api/servers")) showAuth();
    throw new Error(data.error || "حدث خطأ غير متوقع.");
  }
  return data;
}
function showDashboard(user) {
  authScreen.hidden = true; dashboard.hidden = false;
  $("signed-in-as").textContent = user.email;
  ensureAgentConnectButton();
  loadServers();
}
function ensureAgentConnectButton() {
  if ($("connect-agent-button")) return;
  const area = document.querySelector(".sidebar-bottom");
  if (!area) return;
  const button = document.createElement("button");
  button.id = "connect-agent-button";
  button.type = "button";
  button.className = "secondary compact";
  button.textContent = "＋ ربط جهاز الاستضافة";
  button.style.cssText = "margin-top:10px;width:100%;font-size:12px";
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "جارٍ إنشاء رمز الربط...";
    try {
      const data = await api("/api/agent/pair-code", { method: "POST" });
      window.prompt("رمز ربط DragonHost (صالح لمدة 5 دقائق) — أدخله في تطبيق Hosting Agent:", data.code);
    } catch (error) {
      window.alert(error.message);
    } finally {
      button.disabled = false;
      button.textContent = "＋ ربط جهاز الاستضافة";
    }
  });
  area.appendChild(button);
}
function showAuth() { dashboard.hidden = true; authScreen.hidden = false; }

authForm.addEventListener("submit", async (event) => {
  event.preventDefault(); authSubmit.disabled = true;
  authMessage.textContent = authMode === "register" ? "جارٍ إنشاء حسابك..." : "جارٍ تسجيل الدخول...";
  const payload = Object.fromEntries(new FormData(authForm).entries());
  try {
    const data = await api(`/api/auth/${authMode}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    authForm.reset(); showDashboard(data.user);
  } catch (error) { authMessage.textContent = error.message; }
  finally { authSubmit.disabled = false; }
});
$("logout-button").addEventListener("click", async () => {
  try { await api("/api/auth/logout", { method: "POST" }); } catch {}
  showAuth(); setAuthMode("login");
});

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]);
}
async function loadServers() {
  try {
    const data = await api("/api/servers"), servers = data.servers || [];
    cachedServers = servers;
    $("server-count").textContent = servers.length;
    if (!servers.length) {
      list.innerHTML = '<div class="empty-state empty-wide"><div class="empty-icon">🐉</div><b>عالمك الأول بانتظارك</b><p>أنشئ سيرفرك الأول واضبطه بالطريقة التي تحبها.</p><button class="primary compact" data-go-create type="button">إنشاء سيرفر جديد</button></div>';
      list.querySelector("[data-go-create]").addEventListener("click", () => navigate("create"));
      return;
    }
    list.innerHTML = servers.map(s => `<article class="server-card">
      <div class="server-card-top"><span class="server-cube">▦</span><span class="status-pill pending">غير متصل</span></div>
      <h3>${escapeHtml(s.name)}</h3><p class="server-address">${escapeHtml(s.subdomain || "لم يحدد عنوان")} .dragonhost.net</p>
      <div class="server-tags"><span>${escapeHtml(s.edition.toUpperCase())}</span><span>${escapeHtml(s.software)}</span><span>${escapeHtml(s.version)}</span></div>
      <div class="server-card-bottom"><small>بانتظار جهاز الاستضافة</small><button type="button" class="text-button" data-manage-server="${escapeHtml(s.id)}">إدارة السيرفر ⚙</button></div>
    </article>`).join("");
    list.querySelectorAll("[data-manage-server]").forEach(btn => btn.addEventListener("click", () => openServerManager(btn.dataset.manageServer)));
  } catch (error) { list.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`; }
}

function navigate(page) {
  document.querySelectorAll(".nav-item").forEach(btn => btn.classList.toggle("active", btn.dataset.page === page));
  document.querySelectorAll(".page-view").forEach(el => el.hidden = true);
  const known = ["overview", "create"];
  if (known.includes(page)) {
    $(`page-${page}`).hidden = false;
    $("page-title").textContent = page === "overview" ? "نظرة عامة" : "إنشاء سيرفر";
  } else {
    $("page-placeholder").hidden = false;
    const labels = { console:"الكونسول", files:"مدير الملفات", plugins:"الإضافات والمودات", players:"إدارة اللاعبين", worlds:"العوالم والنسخ", settings:"إعدادات السيرفر" };
    $("placeholder-title").textContent = labels[page] || "قريباً";
    $("placeholder-description").textContent = page === "console" ? "نافذة الكونسول متاحة للمعاينة، وسيتم تفعيل الاتصال عند ربط جهاز الاستضافة." : "هذا النظام سيُفعّل في مرحلة التطوير التالية بعد ربط محرك الاستضافة.";
    $("page-title").textContent = labels[page] || "قريباً";
    if (page === "console") openConsole();
  }
}
document.querySelectorAll(".nav-item").forEach(btn => btn.addEventListener("click", () => navigate(btn.dataset.page)));
$("new-server-button").addEventListener("click", () => navigate("create"));

function setStep(step) {
  currentStep = Math.max(1, Math.min(4, step));
  document.querySelectorAll(".wizard-step").forEach(el => el.hidden = Number(el.dataset.step) !== currentStep);
  document.querySelectorAll(".step").forEach(el => {
    const n = Number(el.dataset.stepIndicator);
    el.classList.toggle("active", n === currentStep);
    el.classList.toggle("done", n < currentStep);
  });
  $("wizard-back").hidden = currentStep === 1;
  $("wizard-next").hidden = currentStep === 4;
  $("wizard-create").hidden = currentStep !== 4;
  $("wizard-message").textContent = "";
  if (currentStep === 4) renderReview();
}
$("wizard-next").addEventListener("click", () => {
  if (currentStep === 1 && !validateIdentity()) return;
  if (currentStep === 2 && !$("version").value) return;
  setStep(currentStep + 1);
});
$("wizard-back").addEventListener("click", () => setStep(currentStep - 1));
function validateIdentity() {
  const name = $("server-name").value.trim(), slug = $("subdomain").value.trim().toLowerCase();
  if (name.length < 2) { $("wizard-message").textContent = "اكتب اسماً من حرفين على الأقل."; return false; }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/.test(slug)) { $("wizard-message").textContent = "العنوان يجب أن يحتوي أحرفاً صغيرة أو أرقاماً وشرطة وسطية فقط."; return false; }
  if (!subdomainAvailable) { $("wizard-message").textContent = "تحقق من توفر العنوان قبل المتابعة."; return false; }
  return true;
}

$("subdomain").addEventListener("input", () => {
  const input = $("subdomain"), slug = input.value.trim().toLowerCase();
  input.value = slug; subdomainAvailable = false;
  clearTimeout(subdomainTimer);
  const status = $("subdomain-status");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/.test(slug)) {
    status.textContent = "استخدم 2–24 حرفاً: a-z و0-9 والشرطة في الوسط."; status.className = "field-hint error"; return;
  }
  status.textContent = "جارٍ فحص العنوان..."; status.className = "field-hint";
  subdomainTimer = setTimeout(async () => {
    try {
      const data = await api(`/api/subdomains/check?name=${encodeURIComponent(slug)}`);
      subdomainAvailable = data.available;
      status.textContent = data.available ? "✓ العنوان متاح!" : "هذا العنوان مستخدم، جرّب اسماً آخر.";
      status.className = data.available ? "field-hint success" : "field-hint error";
    } catch (error) { status.textContent = error.message; status.className = "field-hint error"; }
  }, 350);
});
$("motd").addEventListener("input", () => renderMotd($("motd").value));
function renderMotd(text) {
  const palette = { "0":"#000000","1":"#0000aa","2":"#00aa00","3":"#00aaaa","4":"#aa0000","5":"#aa00aa","6":"#ffaa00","7":"#aaaaaa","8":"#555555","9":"#5555ff","a":"#55ff55","b":"#55ffff","c":"#ff5555","d":"#ff55ff","e":"#ffff55","f":"#ffffff" };
  let color = "#55ff55", bold = false, italic = false, underline = false, html = "", buffer = "";
  const flush = () => {
    if (!buffer) return;
    html += '<span style="color:' + color + ';' + (bold ? "font-weight:800;" : "") + (italic ? "font-style:italic;" : "") + (underline ? "text-decoration:underline;" : "") + '">' + escapeHtml(buffer) + '</span>';
    buffer = "";
  };
  const input = String(text || "");
  for (let i = 0; i < input.length; i++) {
    if (input[i] === "§" && i + 1 < input.length) {
      const code = input[++i].toLowerCase();
      if (palette[code]) { flush(); color = palette[code]; bold = false; italic = false; underline = false; }
      else if (code === "l") { flush(); bold = true; }
      else if (code === "o") { flush(); italic = true; }
      else if (code === "n") { flush(); underline = true; }
      else if (code === "r") { flush(); color = "#55ff55"; bold = false; italic = false; underline = false; }
      else buffer += "§" + code;
    } else buffer += input[i];
  }
  flush();
  $("motd-preview-text").innerHTML = html || "رسالة السيرفر ستظهر هنا";
}
document.querySelectorAll('input[name="edition"]').forEach(radio => radio.addEventListener("change", () => {
  document.querySelectorAll(".choice-card").forEach(card => card.classList.toggle("selected", card.querySelector("input").checked));
  const bedrock = document.querySelector('input[name="edition"]:checked').value === "bedrock";
  $("software").disabled = bedrock;
  if (bedrock) $("software").value = "vanilla";
}));
$("maxPlayers").addEventListener("input", () => $("players-value").textContent = $("maxPlayers").value);

function formPayload() {
  const fd = new FormData(wizardForm), edition = fd.get("edition");
  return {
    name: fd.get("name").trim(), subdomain: fd.get("subdomain").trim().toLowerCase(),
    motd: fd.get("motd") || "", edition, software: edition === "bedrock" ? "bedrock" : fd.get("software"),
    version: fd.get("version"), gamemode: fd.get("gamemode"), difficulty: fd.get("difficulty"),
    maxPlayers: Number(fd.get("maxPlayers")), cracked: fd.has("cracked"),
    allowFlight: fd.has("allowFlight"), pvp: fd.has("pvp"), eulaAccepted: $("eula-accepted").checked
  };
}
function renderReview() {
  const p = formPayload();
  const rows = [["اسم السيرفر",p.name],["العنوان",p.subdomain+".dragonhost.net"],["النسخة",p.edition.toUpperCase()],["النواة",p.software],["الإصدار",p.version],["وضع اللعب",p.gamemode],["الصعوبة",p.difficulty],["اللاعبون",p.maxPlayers],["Offline Mode",p.cracked ? "مفعّل" : "معطّل"]];
  $("review-card").innerHTML = rows.map(([k,v]) => `<div><small>${escapeHtml(k)}</small><b>${escapeHtml(v)}</b></div>`).join("");
}
wizardForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (currentStep !== 4 || !validateIdentity()) return;
  if (!$("eula-accepted").checked) { $("wizard-message").textContent = "يجب الموافقة على Minecraft EULA قبل إنشاء السيرفر."; return; }
  const button = $("wizard-create"); button.disabled = true;
  $("wizard-message").textContent = "جارٍ حفظ إعدادات السيرفر...";
  $("provision-status").textContent = "التحقق من الإعدادات وحفظها...";
  $("provision-percent").textContent = "20%"; $("provision-bar").style.width = "20%";
  try {
    const data = await api("/api/servers", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(formPayload()) });
    $("provision-percent").textContent = "100%"; $("provision-bar").style.width = "100%";
    $("provision-status").textContent = "تم حفظ إعدادات السيرفر بنجاح. بانتظار جهاز الاستضافة لتحميل النواة وتشغيل العالم.";
    $("wizard-message").textContent = "تم إنشاء السيرفر! ستجده الآن في لوحة التحكم.";
    await loadServers();
    setTimeout(() => { wizardForm.reset(); $("motd").value = "§aWelcome to §bDragonHost!"; renderMotd($("motd").value); $("subdomain-status").textContent = "استخدم أحرفاً إنجليزية صغيرة وأرقاماً وشرطة فقط."; subdomainAvailable = false; setStep(1); navigate("overview"); }, 1600);
  } catch (error) { $("wizard-message").textContent = error.message; }
  finally { button.disabled = false; }
});

const consoleModal = $("console-modal");
function openConsole() { consoleModal.hidden = false; $("console-close").focus(); }
function closeConsole() { consoleModal.hidden = true; }
$("console-close").addEventListener("click", closeConsole);
consoleModal.addEventListener("click", e => { if (e.target === consoleModal) closeConsole(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !consoleModal.hidden) closeConsole(); });
function openConsole(event) { consoleModal.hidden = false; $("console-close").focus(); }
$("console-form").addEventListener("submit", e => e.preventDefault());


const manager = document.createElement("div");
manager.id = "server-manager-modal";
manager.className = "modal-backdrop";
manager.hidden = true;
manager.innerHTML = `
  <section class="console-modal" role="dialog" aria-modal="true" aria-labelledby="manager-title" style="height:auto;max-height:90vh;overflow:auto">
    <header class="console-header"><div><b id="manager-title">إدارة السيرفر</b><small>إعدادات محفوظة في حسابك</small></div><button id="manager-close" class="icon-button" type="button">✕</button></header>
    <form id="manager-form" style="padding:18px;overflow:auto">
      <label for="manager-name">اسم السيرفر</label><input id="manager-name" maxlength="32" required>
      <label for="manager-motd">رسالة MOTD</label><input id="manager-motd" maxlength="120">
      <div class="two-cols"><div><label for="manager-mode">وضع اللعب</label><select id="manager-mode"><option value="survival">Survival</option><option value="creative">Creative</option><option value="adventure">Adventure</option></select></div><div><label for="manager-difficulty">الصعوبة</label><select id="manager-difficulty"><option value="peaceful">Peaceful</option><option value="easy">Easy</option><option value="normal">Normal</option><option value="hard">Hard</option></select></div></div>
      <label for="manager-max">الحد الأقصى للاعبين</label><input id="manager-max" type="number" min="1" max="100" required>
      <div class="toggle-row"><b>Offline / Cracked</b><label class="switch"><input id="manager-cracked" type="checkbox"><span></span></label></div>
      <div class="toggle-row"><b>السماح بالطيران</b><label class="switch"><input id="manager-flight" type="checkbox"><span></span></label></div>
      <div class="toggle-row"><b>تفعيل PvP</b><label class="switch"><input id="manager-pvp" type="checkbox"><span></span></label></div>
      <p id="manager-message" class="form-message" role="status"></p>
      <div class="wizard-actions"><button class="primary compact" type="submit">حفظ التعديلات</button><span class="wizard-spacer"></span><button id="manager-delete" class="secondary" type="button">حذف السيرفر</button></div>
      <div class="notice"><b>التشغيل الفعلي</b><p>إدارة الإعدادات متاحة. تشغيل Minecraft والكونسول والملفات يحتاج ربط جهاز Hosting Agent؛ لن نعرض حالة تشغيل وهمية.</p></div>
    </form>
  </section>`;
document.body.appendChild(manager);
let managingServerId = null;
function openServerManager(id) {
  const server = cachedServers.find(item => item.id === id);
  if (!server) return;
  managingServerId = id;
  $("manager-name").value = server.name || "";
  $("manager-motd").value = server.motd || "";
  $("manager-mode").value = server.gamemode || "survival";
  $("manager-difficulty").value = server.difficulty || "normal";
  $("manager-max").value = server.maxPlayers || 20;
  $("manager-cracked").checked = !!server.cracked;
  $("manager-flight").checked = !!server.allowFlight;
  $("manager-pvp").checked = server.pvp !== false;
  $("manager-message").textContent = "";
  manager.hidden = false;
}
$("manager-close").addEventListener("click", () => manager.hidden = true);
manager.addEventListener("click", event => { if (event.target === manager) manager.hidden = true; });
$("manager-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = $("manager-form").querySelector('[type="submit"]');
  button.disabled = true;
  $("manager-message").textContent = "جارٍ حفظ الإعدادات...";
  const payload = {
    name: $("manager-name").value.trim(), motd: $("manager-motd").value,
    gamemode: $("manager-mode").value, difficulty: $("manager-difficulty").value,
    maxPlayers: Number($("manager-max").value), cracked: $("manager-cracked").checked,
    allowFlight: $("manager-flight").checked, pvp: $("manager-pvp").checked
  };
  try {
    await api("/api/servers/" + encodeURIComponent(managingServerId), {
      method: "PATCH", headers: {"Content-Type":"application/json"}, body: JSON.stringify(payload)
    });
    $("manager-message").textContent = "تم حفظ التعديلات بنجاح.";
    await loadServers();
  } catch (error) { $("manager-message").textContent = error.message; }
  finally { button.disabled = false; }
});
$("manager-delete").addEventListener("click", async () => {
  if (!managingServerId || !confirm("متأكد أنك تريد حذف هذا السيرفر وإعداداته نهائياً؟")) return;
  const button = $("manager-delete");
  button.disabled = true;
  try {
    await api("/api/servers/" + encodeURIComponent(managingServerId), {method:"DELETE"});
    manager.hidden = true;
    await loadServers();
  } catch (error) { $("manager-message").textContent = error.message; }
  finally { button.disabled = false; }
});

(async function init() {
  try { const data = await api("/api/auth/me"); showDashboard(data.user); }
  catch { showAuth(); }
})();