// --- DB setup (IndexedDB via Dexie) ---
const db = new Dexie("ReceptenDB");
db.version(1).stores({
  docs: "++id, title, updatedAt",
  favorites: "++id, name, query, createdAt"
});

// --- Helpers ---
const $ = (id) => document.getElementById(id);

function normalizeTags(input) {
  // comma-separated -> array of trimmed tags, remove empties, unique, keep original case but compare lower
  const parts = (input || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  // unique (case-insensitive)
  const seen = new Set();
  const out = [];
  for (const t of parts) {
    const key = t.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(t); }
  }
  return out;
}

function tagsToString(tags) {
  return (tags || []).join(", ");
}

function setStatus(msg, kind = "") {
  const el = $("status");
  el.textContent = msg || "";
  el.className = "status" + (kind ? ` ${kind}` : "");
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

// --- Rendering ---
async function renderDocs() {
  const docs = await db.docs.orderBy("updatedAt").reverse().toArray();
  $("docsMeta").textContent = `${docs.length} recept(en) in de database.`;

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
        <div>
          <button data-open="${d.id}">Open</button>
        </div>
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
  const favs = await db.favorites.orderBy("createdAt").reverse().toArray();
  const ul = $("favList");
  ul.innerHTML = "";

  if (favs.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "Nog geen favorieten.";
    ul.appendChild(li);
    return;
  }

  for (const f of favs) {
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
      const fav = await db.favorites.get(id);
      if (!fav) return;
      $("searchInput").value = fav.query;
      await runSearch();
    });
  });

  ul.querySelectorAll("button[data-del]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.getAttribute("data-del"));
      await db.favorites.delete(id);
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
        <div>
          <button data-open="${d.id}">Open</button>
        </div>
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

// --- CRUD ---
async function clearEditor() {
  $("docId").value = "";
  $("docTitle").value = "";
  $("docTags").value = "";
  $("docContent").value = "";
  $("editorTitle").textContent = "Editor";
  setStatus("");
}

async function loadDoc(id) {
  const d = await db.docs.get(id);
  if (!d) return;

  $("docId").value = String(d.id);
  $("docTitle").value = d.title || "";
  $("docTags").value = tagsToString(d.tags);
  $("docContent").value = d.content || "";
  $("editorTitle").textContent = `Editor (ID: ${d.id})`;
  setStatus("Document geladen.", "ok");
}

async function saveDoc() {
  const idRaw = $("docId").value.trim();
  const title = $("docTitle").value.trim();
  const tags = normalizeTags($("docTags").value);
  const content = $("docContent").value;

  if (!title && !content.trim()) {
    setStatus("Geef minstens een titel of inhoud.", "err");
    return;
  }

  const now = Date.now();

  if (idRaw) {
    const id = Number(idRaw);
    await db.docs.update(id, { title, tags, content, updatedAt: now });
    setStatus("Wijzigingen opgeslagen.", "ok");
  } else {
    const newId = await db.docs.add({ title, tags, content, updatedAt: now });
    $("docId").value = String(newId);
    $("editorTitle").textContent = `Editor (ID: ${newId})`;
    setStatus("Nieuw document opgeslagen.", "ok");
  }

  await renderDocs();
}

async function deleteDoc() {
  const idRaw = $("docId").value.trim();
  if (!idRaw) {
    setStatus("Geen document geselecteerd om te verwijderen.", "err");
    return;
  }
  const id = Number(idRaw);
  await db.docs.delete(id);
  await clearEditor();
  await renderDocs();
  setStatus("Document verwijderd.", "ok");
}

// --- Search in tags (substring contains) ---
async function runSearch() {
  const q = $("searchInput").value.trim().toLowerCase();
  if (!q) {
    renderResults([], "");
    $("resultsMeta").textContent = "Geef een zoekterm in.";
    return;
  }

  const all = await db.docs.toArray();
  const results = all.filter(d =>
    (d.tags || []).some(t => t.toLowerCase().includes(q))
  );

  renderResults(results, q);
}

async function saveFavorite() {
  const q = $("searchInput").value.trim();
  const name = $("favName").value.trim();

  if (!q) { setStatus("Geen zoekterm om te bewaren.", "err"); return; }
  if (!name) { setStatus("Geef een naam voor de favoriet.", "err"); return; }

  await db.favorites.add({ name, query: q, createdAt: Date.now() });
  $("favName").value = "";
  await renderFavorites();
  setStatus("Favoriet opgeslagen.", "ok");
}

// --- PWA registration ---
async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("./sw.js");
  } catch (_) {
    // service workers vereisen meestal http(s), niet file://
  }
}

// --- Wire up UI ---
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

  // Demo-content als DB leeg is
  const count = await db.docs.count();
  if (count === 0) {
    await db.docs.add({
      title: "Demo: Snelle pasta",
      tags: ["pasta", "snel", "vega"],
      content: "Kook pasta. Bak look + chili in olijfolie. Voeg pasta + pastawater toe. Werk af met peterselie.",
      updatedAt: Date.now()
    });
  }

  await renderDocs();
  await renderFavorites();
});
