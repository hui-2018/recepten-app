// ---- Supabase config ----
const SUPABASE_URL = "https://bduuymwmpjxnkhunreyl.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_PYkma9AgJZyhzTmwLRArxg_6Mggyyp8";
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---- UI helpers ----
const $ = (id) => document.getElementById(id);

function normalizeTags(input) {
  const parts = (input || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const seen = new Set();
  const out = [];
  for (const t of parts) {
    const key = t.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(t); }
  }
  return out;
}

function tagsToString(tags) { return (tags || []).join(", "); }

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function setStatus(msg, kind="") {
  const el = $("status");
  el.textContent = msg || "";
  el.className = "status" + (kind ? ` ${kind}` : "");
}

let currentUser = null;

// ---- Auth ----
async function refreshAuth() {
  const { data: { user } } = await supabase.auth.getUser();
  currentUser = user || null;

  $("authInfo").textContent = currentUser ? `Ingelogd als ${currentUser.email}` : "Niet ingelogd";
  document.body.classList.toggle("logged-in", !!currentUser);

  // pas knoppen aan
  $("btnLogout").style.display = currentUser ? "inline-block" : "none";
}

async function loginWithMagicLink() {
  const email = $("email").value.trim();
  if (!email) { setStatus("Geef je e-mail in.", "err"); return; }

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.href }
  });

  if (error) { setStatus(error.message, "err"); return; }
  setStatus("Check je e-mail voor de login link.", "ok");
}

async function logout() {
  await supabase.auth.signOut();
  await refreshAuth();
  await clearEditor();
  await renderDocs();
  await renderFavorites();
  setStatus("Uitgelogd.", "ok");
}

// ---- DB helpers (tags) ----
async function upsertTags(tagNames) {
  // Zorg dat tags bestaan voor deze user, return tag rows
  const names = tagNames.map(t => t.trim()).filter(Boolean);
  if (names.length === 0) return [];

  // Haal bestaande tags op (case-insensitive vergelijken doen we simpel met lower in JS)
  const { data: existing, error: e1 } = await supabase
    .from("tags")
    .select("id,name")
    .eq("user_id", currentUser.id);

  if (e1) throw e1;

  const existingMap = new Map(existing.map(t => [t.name.toLowerCase(), t]));
  const toInsert = [];

  for (const n of names) {
    if (!existingMap.has(n.toLowerCase())) toInsert.push({ user_id: currentUser.id, name: n });
  }

  if (toInsert.length > 0) {
    const { error: e2 } = await supabase.from("tags").insert(toInsert);
    if (e2) throw e2;
  }

  // opnieuw ophalen zodat we alle ids hebben
  const { data: allTags, error: e3 } = await supabase
    .from("tags")
    .select("id,name")
    .eq("user_id", currentUser.id);

  if (e3) throw e3;

  const out = [];
  const allMap = new Map(allTags.map(t => [t.name.toLowerCase(), t]));
  for (const n of names) out.push(allMap.get(n.toLowerCase()));
  return out.filter(Boolean);
}

async function setRecipeTags(recipeId, tagNames) {
  const tags = await upsertTags(tagNames);

  // delete oude links
  const { error: d1 } = await supabase
    .from("recipe_tags")
    .delete()
    .eq("recipe_id", recipeId);

  if (d1) throw d1;

  // insert nieuwe links
  if (tags.length > 0) {
    const rows = tags.map(t => ({ recipe_id: recipeId, tag_id: t.id }));
    const { error: i1 } = await supabase.from("recipe_tags").insert(rows);
    if (i1) throw i1;
  }
}

// ---- Rendering ----
async function renderDocs() {
  if (!currentUser) {
    $("docsMeta").textContent = "Login om je recepten te zien.";
    $("docsList").innerHTML = "";
    return;
  }

  // haal recepten + tags op via join
  const { data, error } = await supabase
    .from("recipes")
    .select(`
      id, title, content, updated_at,
      recipe_tags ( tags ( id, name ) )
    `)
    .eq("user_id", currentUser.id)
    .order("updated_at", { ascending: false });

  if (error) { setStatus(error.message, "err"); return; }

  const docs = (data || []).map(r => ({
    id: r.id,
    title: r.title,
    content: r.content,
    updatedAt: r.updated_at,
    tags: (r.recipe_tags || []).map(rt => rt.tags?.name).filter(Boolean)
  }));

  $("docsMeta").textContent = `${docs.length} recept(en) in de cloud.`;

  const ul = $("docsList");
  ul.innerHTML = "";

  for (const d of docs) {
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
        <div><button data-open="${d.id}">Open</button></div>
      </div>
    `;
    ul.appendChild(li);
  }

  ul.querySelectorAll("button[data-open]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.getAttribute("data-open"));
      await loadDoc(id);
    });
  });
}

async function renderFavorites() {
  if (!currentUser) {
    $("favList").innerHTML = `<li class="muted">Login om favorieten te zien.</li>`;
    return;
  }

  const { data, error } = await supabase
    .from("favorite_searches")
    .select("id,name,query,created_at")
    .eq("user_id", currentUser.id)
    .order("created_at", { ascending: false });

  if (error) { setStatus(error.message, "err"); return; }

  const ul = $("favList");
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
      const fav = data.find(x => x.id === id);
      if (!fav) return;
      $("searchInput").value = fav.query;
      await runSearch();
    });
  });

  ul.querySelectorAll("button[data-del]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.getAttribute("data-del"));
      const { error } = await supabase
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
        <div><button data-open="${d.id}">Open</button></div>
      </div>
    `;
    ul.appendChild(li);
  }

  ul.querySelectorAll("button[data-open]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.getAttribute("data-open"));
      await loadDoc(id);
    });
  });
}

// ---- Editor ----
async function clearEditor() {
  $("docId").value = "";
  $("docTitle").value = "";
  $("docTags").value = "";
  $("docContent").value = "";
  $("editorTitle").textContent = "Editor";
  setStatus("");
}

async function loadDoc(id) {
  if (!currentUser) return;

  const { data, error } = await supabase
    .from("recipes")
    .select(`
      id,title,content,updated_at,
      recipe_tags ( tags ( name ) )
    `)
    .eq("id", id)
    .eq("user_id", currentUser.id)
    .single();

  if (error) { setStatus(error.message, "err"); return; }

  $("docId").value = String(data.id);
  $("docTitle").value = data.title || "";
  $("docContent").value = data.content || "";
  const tags = (data.recipe_tags || []).map(rt => rt.tags?.name).filter(Boolean);
  $("docTags").value = tagsToString(tags);

  $("editorTitle").textContent = `Editor (ID: ${data.id})`;
  setStatus("Document geladen.", "ok");
}

async function saveDoc() {
  if (!currentUser) { setStatus("Login om op te slaan.", "err"); return; }

  const idRaw = $("docId").value.trim();
  const title = $("docTitle").value.trim();
  const content = $("docContent").value;
  const tagNames = normalizeTags($("docTags").value);

  if (!title && !content.trim()) {
    setStatus("Geef minstens een titel of inhoud.", "err");
    return;
  }

  if (idRaw) {
    const id = Number(idRaw);
    const { error } = await supabase
      .from("recipes")
      .update({ title, content, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", currentUser.id);

    if (error) { setStatus(error.message, "err"); return; }

    await setRecipeTags(id, tagNames);
    setStatus("Wijzigingen opgeslagen.", "ok");
  } else {
    const { data, error } = await supabase
      .from("recipes")
      .insert([{ user_id: currentUser.id, title, content, updated_at: new Date().toISOString() }])
      .select("id")
      .single();

    if (error) { setStatus(error.message, "err"); return; }

    const newId = data.id;
    await setRecipeTags(newId, tagNames);

    $("docId").value = String(newId);
    $("editorTitle").textContent = `Editor (ID: ${newId})`;
    setStatus("Nieuw document opgeslagen.", "ok");
  }

  await renderDocs();
}

async function deleteDoc() {
  if (!currentUser) return;

  const idRaw = $("docId").value.trim();
  if (!idRaw) { setStatus("Geen document geselecteerd.", "err"); return; }

  const id = Number(idRaw);

  // links verwijderen (RLS kan cascade ook, maar expliciet is ok)
  await supabase.from("recipe_tags").delete().eq("recipe_id", id);

  const { error } = await supabase
    .from("recipes")
    .delete()
    .eq("id", id)
    .eq("user_id", currentUser.id);

  if (error) { setStatus(error.message, "err"); return; }

  await clearEditor();
  await renderDocs();
  setStatus("Document verwijderd.", "ok");
}

// ---- Search: tags contains ----
async function runSearch() {
  if (!currentUser) { setStatus("Login om te zoeken.", "err"); return; }
  const q = $("searchInput").value.trim();
  if (!q) {
    $("resultsMeta").textContent = "Geef een zoekterm in.";
    $("resultsList").innerHTML = "";
    return;
  }

  // 1) zoek tags met contains
  const { data: tags, error: e1 } = await supabase
    .from("tags")
    .select("id,name")
    .eq("user_id", currentUser.id)
    .ilike("name", `%${q}%`);

  if (e1) { setStatus(e1.message, "err"); return; }
  if (!tags || tags.length === 0) {
    renderResults([], q);
    return;
  }

  const tagIds = tags.map(t => t.id);

  // 2) vind recipes die gekoppeld zijn aan die tags
  const { data: rows, error: e2 } = await supabase
    .from("recipe_tags")
    .select(`
      recipe_id,
      recipes ( id,title,updated_at, recipe_tags ( tags ( name ) ) )
    `)
    .in("tag_id", tagIds);

  if (e2) { setStatus(e2.message, "err"); return; }

  // dedupe recipes
  const map = new Map();
  for (const r of rows || []) {
    const rec = r.recipes;
    if (!rec) continue;
    if (!map.has(rec.id)) {
      const recTags = (rec.recipe_tags || []).map(rt => rt.tags?.name).filter(Boolean);
      map.set(rec.id, { id: rec.id, title: rec.title, updatedAt: rec.updated_at, tags: recTags });
    }
  }

  const results = Array.from(map.values());
  renderResults(results, q);
}

async function saveFavorite() {
  if (!currentUser) { setStatus("Login om favorieten te bewaren.", "err"); return; }

  const q = $("searchInput").value.trim();
  const name = $("favName").value.trim();
  if (!q) { setStatus("Geen zoekterm om te bewaren.", "err"); return; }
  if (!name) { setStatus("Geef een naam voor de favoriet.", "err"); return; }

  const { error } = await supabase.from("favorite_searches").insert([{
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

// ---- PWA SW (kan blijven) ----
async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try { await navigator.serviceWorker.register("./sw.js"); } catch (_) {}
}

// ---- Wire up ----
window.addEventListener("DOMContentLoaded", async () => {
  await registerServiceWorker();

  $("btnNew").addEventListener("click", clearEditor);
  $("btnClear").addEventListener("click", clearEditor);
  $("btnSave").addEventListener("click", saveDoc);
  $("btnDelete").addEventListener("click", deleteDoc);

  $("btnSearch").addEventListener("click", runSearch);
  $("searchInput").addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });
  $("btnSaveFav").addEventListener("click", saveFavorite);

  $("btnLogin").addEventListener("click", loginWithMagicLink);
  $("btnLogout").addEventListener("click", logout);

  // auth state changes
  supabase.auth.onAuthStateChange(async () => {
    await refreshAuth();
    await renderDocs();
    await renderFavorites();
  });

  await refreshAuth();
  await renderDocs();
  await renderFavorites();
});
