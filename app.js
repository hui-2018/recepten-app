// ===============================
// Recepten DB (Drive-link versie)
// ===============================

// Vul deze 2 waarden in vanuit Supabase: Project Settings → API
const SUPABASE_URL = "https://bduuymwmpjxnkhunreyl.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkdXV5bXdtcGp4bmtodW5yZXlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAzMDEzNTMsImV4cCI6MjA4NTg3NzM1M30.jD64IVrN3e9Qjb9Xq1PzMQxplhLmM5FCOtV31gfE8Sc";

// Supabase client via CDN
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Helpers
const $ = (id) => document.getElementById(id);

function setStatus(msg, kind = "") {
  const el = $("status");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "status" + (kind ? ` ${kind}` : "");
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

function normalizeTags(input) {
  const parts = (input || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const seen = new Set();
  const out = [];
  for (const t of parts) {
    const k = t.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(t); }
  }
  return out;
}

function tagsToString(tags) {
  return (tags || []).join(", ");
}

function appBaseUrl() {
  return "https://hui-2018.github.io/recepten-app/";
}

// (optioneel) maak van een Drive link een preview link
function drivePreviewUrl(url) {
  if (!url) return "";
  const m1 = url.match(/\/file\/d\/([^/]+)/);
  const m2 = url.match(/[?&]id=([^&]+)/);
  const fileId = (m1 && m1[1]) || (m2 && m2[1]) || "";
  return fileId ? `https://drive.google.com/file/d/${fileId}/preview` : url;
}

// State
let currentUser = null;

// -------------------------------
// Auth
// -------------------------------
async function refreshAuth() {
  const { data: { user }, error } = await sb.auth.getUser();
  if (error) {
    currentUser = null;
    setStatus(error.message, "err");
  } else {
    currentUser = user || null;
  }

  const info = $("authInfo");
  if (info) info.textContent = currentUser ? `Ingelogd als ${currentUser.email}` : "Niet ingelogd";

  const logoutBtn = $("btnLogout");
  if (logoutBtn) logoutBtn.style.display = currentUser ? "inline-block" : "none";
}

async function loginWithMagicLink() {
  const email = $("email").value.trim();
  if (!email) { setStatus("Geef je e-mail in.", "err"); return; }

  const btn = $("btnLogin");
  if (btn) btn.disabled = true;

  try {
    setStatus("Bezig met login-link versturen... (klik niet opnieuw)", "");

    const { error } = await sb.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: appBaseUrl(),
        shouldCreateUser: true
      }
    });

    if (error) {
      setStatus("Supabase error: " + error.message, "err");
      return;
    }

    setStatus("Mail verstuurd. Check je inbox en spam.", "ok");
  } finally {
    if (btn) setTimeout(() => { btn.disabled = false; }, 8000);
  }
}

async function logout() {
  await sb.auth.signOut();
  await refreshAuth();
  await clearEditor();
  await renderDocs();
  await renderFavorites();
  setStatus("Uitgelogd.", "ok");
}

// -------------------------------
// Tags (many-to-many)
// -------------------------------
async function getAllTagsForUser() {
  const { data, error } = await sb
    .from("tags")
    .select("id,name")
    .eq("user_id", currentUser.id)
    .order("name", { ascending: true });

  if (error) throw error;
  return data || [];
}

async function upsertTags(tagNames) {
  const names = (tagNames || []).map(t => t.trim()).filter(Boolean);
  if (names.length === 0) return [];

  const existing = await getAllTagsForUser();
  const map = new Map(existing.map(t => [t.name.toLowerCase(), t]));

  const toInsert = [];
  for (const n of names) {
    if (!map.has(n.toLowerCase())) {
      toInsert.push({ user_id: currentUser.id, name: n });
    }
  }

  if (toInsert.length > 0) {
    const { error } = await sb.from("tags").insert(toInsert);
    if (error) throw error;
  }

  const all = await getAllTagsForUser();
  const allMap = new Map(all.map(t => [t.name.toLowerCase(), t]));
  return names.map(n => allMap.get(n.toLowerCase())).filter(Boolean);
}

async function setRecipeTags(recipeId, tagNames) {
  const tags = await upsertTags(tagNames);

  const { error: delErr } = await sb
    .from("recipe_tags")
    .delete()
    .eq("recipe_id", recipeId);

  if (delErr) throw delErr;

  if (tags.length > 0) {
    const rows = tags.map(t => ({ recipe_id: recipeId, tag_id: t.id }));
    const { error: insErr } = await sb.from("recipe_tags").insert(rows);
    if (insErr) throw insErr;
  }
}

// -------------------------------
// Rendering
// -------------------------------
async function renderDocs() {
  const meta = $("docsMeta");
  const list = $("docsList");
  if (!meta || !list) return;

  if (!currentUser) {
    meta.textContent = "Login om je recepten te zien.";
    list.innerHTML = "";
    return;
  }

  const { data, error } = await sb
    .from("recipes")
    .select(`
      id, title, drive_url, updated_at, user_id,
      recipe_tags ( tags ( id, name ) )
    `)
    .eq("user_id", currentUser.id)
    .order("updated_at", { ascending: false });

  if (error) { setStatus(error.message, "err"); return; }

  const docs = (data || []).map(r => ({
    id: r.id,
    title: r.title,
    driveUrl: r.drive_url,
    updatedAt: r.updated_at,
    tags: (r.recipe_tags || []).map(rt => rt.tags?.name).filter(Boolean)
  }));

  meta.textContent = `${docs.length} recept(en) in de cloud.`;
  list.innerHTML = "";

  for (const d of docs) {
    const pdfLink = d.driveUrl ? d.driveUrl : "#";
    const pdfDisabled = d.driveUrl ? "" : "style='pointer-events:none;opacity:.5;'";
    const li = document.createElement("li");
    li.className = "item";
    li.innerHTML = `
      <div class="itemTop">
        <div>
          <div><strong>${escapeHtml(d.title || "(zonder titel)")}</strong></div>
          <div class="muted">Laatst aangepast: ${new Date(d.updatedAt).toLocaleString()}</div>
          <div class="badges">
            ${(d.tags || []).map(t => `<span class="badge">${escapeHtml(t)}</span>`).join("")}
          </div>
        </div>
        <div style="display:flex; gap:8px; align-items:center;">
          <button data-open="${d.id}">Open</button>
          <a class="secondary" href="${escapeHtml(pdfLink)}" target="_blank" ${pdfDisabled}>PDF</a>
        </div>
      </div>
    `;
    list.appendChild(li);
  }

  list.querySelectorAll("button[data-open]").forEach(btn => {
    btn.addEventListener("click", async () => {
      await loadDoc(Number(btn.getAttribute("data-open")));
    });
  });
}

async function renderFavorites() {
  const ul = $("favList");
  if (!ul) return;

  if (!currentUser) {
    ul.innerHTML = `<li class="muted">Login om favorieten te zien.</li>`;
    return;
  }

  const { data, error } = await sb
    .from("favorite_searches")
    .select("id,name,query,created_at,user_id")
    .eq("user_id", currentUser.id)
    .order("created_at", { ascending: false });

  if (error) { setStatus(error.message, "err"); return; }

  ul.innerHTML = "";

  if (!data || data.length === 0) {
    ul.innerHTML = `<li class="muted">Nog geen favorieten.</li>`;
    return;
  }

  for (const f of data) {
    const li = document.createElement("li");
    li.className = "item";
    li.innerHTML = `
      <div class="itemTop">
        <div>
          <div><strong>${escapeHtml(f.name)}</strong></div>
          <div class="muted">Query: ${escapeHtml(f.query)}</div>
        </div>
        <div style="display:flex; gap:8px;">
          <button data-run="${f.id}">Gebruik</button>
          <button data-del="${f.id}" class="danger">X</button>
        </div>
      </div>
    `;
    ul.appendChild(li);
  }

  ul.querySelectorAll("button[data-run]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.getAttribute("data-run"));
      const { data: fav, error } = await sb
        .from("favorite_searches")
        .select("query")
        .eq("id", id)
        .eq("user_id", currentUser.id)
        .single();

      if (error) { setStatus(error.message, "err"); return; }

      $("searchInput").value = fav.query;
      await runSearch();
    });
  });

  ul.querySelectorAll("button[data-del]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.getAttribute("data-del"));
      const { error } = await sb
        .from("favorite_searches")
        .delete()
        .eq("id", id)
        .eq("user_id", currentUser.id);

      if (error) { setStatus(error.message, "err"); return; }
      await renderFavorites();
      setStatus("Favoriet verwijderd.", "ok");
    });
  });
}

function renderResults(results, query) {
  $("resultsMeta").textContent = `${results.length} resultaat/resultaten voor "${query}".`;
  const ul = $("resultsList");
  ul.innerHTML = "";

  for (const d of results) {
    const pdfLink = d.driveUrl ? d.driveUrl : "#";
    const pdfDisabled = d.driveUrl ? "" : "style='pointer-events:none;opacity:.5;'";
    const li = document.createElement("li");
    li.className = "item";
    li.innerHTML = `
      <div class="itemTop">
        <div>
          <div><strong>${escapeHtml(d.title || "(zonder titel)")}</strong></div>
          <div class="badges">
            ${(d.tags || []).map(t => `<span class="badge">${escapeHtml(t)}</span>`).join("")}
          </div>
        </div>
        <div style="display:flex; gap:8px; align-items:center;">
          <button data-open="${d.id}">Open</button>
          <a class="secondary" href="${escapeHtml(pdfLink)}" target="_blank" ${pdfDisabled}>PDF</a>
        </div>
      </div>
    `;
    ul.appendChild(li);
  }

  ul.querySelectorAll("button[data-open]").forEach(btn => {
    btn.addEventListener("click", async () => {
      await loadDoc(Number(btn.getAttribute("data-open")));
    });
  });
}

// -------------------------------
// Editor CRUD
// -------------------------------
async function clearEditor() {
  $("docId").value = "";
  $("docTitle").value = "";
  $("docTags").value = "";
  $("docDriveUrl").value = "";

  const a = $("docOpenLink");
  a.style.display = "none";
  a.href = "#";

  $("editorTitle").textContent = "Editor";
  setStatus("");
}

async function loadDoc(id) {
  if (!currentUser) return;

  const { data, error } = await sb
    .from("recipes")
    .select(`
      id,title,drive_url,updated_at,user_id,
      recipe_tags ( tags ( name ) )
    `)
    .eq("id", id)
    .eq("user_id", currentUser.id)
    .single();

  if (error) { setStatus(error.message, "err"); return; }

  $("docId").value = String(data.id);
  $("docTitle").value = data.title || "";

  const tags = (data.recipe_tags || []).map(rt => rt.tags?.name).filter(Boolean);
  $("docTags").value = tagsToString(tags);

  $("docDriveUrl").value = data.drive_url || "";

  const a = $("docOpenLink");
  if (data.drive_url) {
    a.href = data.drive_url;
    a.style.display = "inline";
  } else {
    a.href = "#";
    a.style.display = "none";
  }

  $("editorTitle").textContent = `Editor (ID: ${data.id})`;
  setStatus("Document geladen.", "ok");
}

async function saveDoc() {
  if (!currentUser) { setStatus("Login om op te slaan.", "err"); return; }

  const idRaw = $("docId").value.trim();
  const title = $("docTitle").value.trim();
  const drive_url = $("docDriveUrl").value.trim();
  const tagNames = normalizeTags($("docTags").value);

  if (!title) { setStatus("Geef een titel.", "err"); return; }
  if (!drive_url) { setStatus("Plak de Google Drive link naar je PDF.", "err"); return; }

  if (idRaw) {
    const id = Number(idRaw);
    const { error } = await sb
      .from("recipes")
      .update({ title, drive_url, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", currentUser.id);

    if (error) { setStatus(error.message, "err"); return; }

    try {
      await setRecipeTags(id, tagNames);
    } catch (e) {
      setStatus(e.message || String(e), "err");
      return;
    }

    setStatus("Wijzigingen opgeslagen.", "ok");
  } else {
    const { data, error } = await sb
      .from("recipes")
      .insert([{
        user_id: currentUser.id,
        title,
        drive_url,
        updated_at: new Date().toISOString()
      }])
      .select("id")
      .single();

    if (error) { setStatus(error.message, "err"); return; }

    const newId = data.id;

    try {
      await setRecipeTags(newId, tagNames);
    } catch (e) {
      setStatus(e.message || String(e), "err");
      return;
    }

    $("docId").value = String(newId);
    $("editorTitle").textContent = `Editor (ID: ${newId})`;
    setStatus("Nieuw document opgeslagen.", "ok");
  }

  // update "open link" in editor
  const a = $("docOpenLink");
  a.href = drive_url;
  a.style.display = "inline";

  await renderDocs();
}

async function deleteDoc() {
  if (!currentUser) return;

  const idRaw = $("docId").value.trim();
  if (!idRaw) { setStatus("Geen document geselecteerd.", "err"); return; }
  const id = Number(idRaw);

  await sb.from("recipe_tags").delete().eq("recipe_id", id);

  const { error } = await sb
    .from("recipes")
    .delete()
    .eq("id", id)
    .eq("user_id", currentUser.id);

  if (error) { setStatus(error.message, "err"); return; }

  await clearEditor();
  await renderDocs();
  setStatus("Document verwijderd.", "ok");
}

// -------------------------------
// Search (tags contains)
// -------------------------------
async function runSearch() {
  if (!currentUser) { setStatus("Login om te zoeken.", "err"); return; }

  const q = $("searchInput").value.trim();
  if (!q) {
    $("resultsMeta").textContent = "Geef een zoekterm in.";
    $("resultsList").innerHTML = "";
    return;
  }

  const { data: tags, error: e1 } = await sb
    .from("tags")
    .select("id,name")
    .eq("user_id", currentUser.id)
    .ilike("name", `%${q}%`);

  if (e1) { setStatus(e1.message, "err"); return; }
  if (!tags || tags.length === 0) { renderResults([], q); return; }

  const tagIds = tags.map(t => t.id);

  const { data: rows, error: e2 } = await sb
    .from("recipe_tags")
    .select(`
      recipe_id,
      recipes ( id,title,drive_url,updated_at,user_id, recipe_tags ( tags ( name ) ) )
    `)
    .in("tag_id", tagIds);

  if (e2) { setStatus(e2.message, "err"); return; }

  const map = new Map();
  for (const r of rows || []) {
    const rec = r.recipes;
    if (!rec) continue;
    if (rec.user_id !== currentUser.id) continue;

    if (!map.has(rec.id)) {
      const recTags = (rec.recipe_tags || []).map(rt => rt.tags?.name).filter(Boolean);
      map.set(rec.id, {
        id: rec.id,
        title: rec.title,
        driveUrl: rec.drive_url,
        updatedAt: rec.updated_at,
        tags: recTags
      });
    }
  }

  renderResults(Array.from(map.values()), q);
}

// -------------------------------
// Favorites
// -------------------------------
async function saveFavorite() {
  if (!currentUser) { setStatus("Login om favorieten te bewaren.", "err"); return; }

  const q = $("searchInput").value.trim();
  const name = $("favName").value.trim();
  if (!q) { setStatus("Geen zoekterm om te bewaren.", "err"); return; }
  if (!name) { setStatus("Geef een naam voor de favoriet.", "err"); return; }

  const { error } = await sb.from("favorite_searches").insert([{
    user_id: currentUser.id,
    name,
    query: q,
    created_at: new Date().toISOString()
  }]);

  if (error) { setStatus(error.message, "err"); return; }

  $("favName").value = "";
  await renderFavorites();
  setStatus("Favoriet opgeslagen.", "ok");
}

// -------------------------------
// PWA
// -------------------------------
async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try { await navigator.serviceWorker.register("./sw.js"); } catch (_) {}
}

// -------------------------------
// Boot
// -------------------------------
window.addEventListener("DOMContentLoaded", async () => {
  await registerServiceWorker();

  $("btnNew").addEventListener("click", clearEditor);
  $("btnClear").addEventListener("click", clearEditor);
  $("btnSave").addEventListener("click", saveDoc);
  $("btnDelete").addEventListener("click", deleteDoc);

  $("btnSearch").addEventListener("click", runSearch);
  $("searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch();
  });

  $("btnSaveFav").addEventListener("click", saveFavorite);

  $("btnLogin").addEventListener("click", loginWithMagicLink);
  $("btnLogout").addEventListener("click", logout);

  sb.auth.onAuthStateChange(async (event) => {
    await refreshAuth();

    if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
      await renderDocs();
      await renderFavorites();
    }

    if (event === "SIGNED_OUT") {
      $("docsMeta").textContent = "Login om je recepten te zien.";
      $("docsList").innerHTML = "";
      $("favList").innerHTML = `<li class="muted">Login om favorieten te zien.</li>`;
      $("resultsMeta").textContent = "";
      $("resultsList").innerHTML = "";
    }
  });

  await refreshAuth();
  await renderDocs();
  await renderFavorites();
});
