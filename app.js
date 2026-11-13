// LocalWallet — single-page account tracker with snapshot history.
// State is kept in chrome.storage.local under a single key and, when the user signs in
// with Google, mirrored to a hidden file in their own Google Drive (appDataFolder).

const STORAGE_KEY = "localwallet";
const SYNC_KEY = "localwallet_sync"; // { enabled, fileId, email } — per device, never synced
const DRIVE_FILE = "localwallet.json";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
// Official NBS middle rates, served as JSON (NBS itself only offers a SOAP API that needs registration).
const RATES_API = "https://kurs.resenje.org/api/v1/rates/";
const NBS_URL = "https://www.nbs.rs/kursnaListaModul/srednjiKurs.faces?lang=lat";

const $ = (sel) => document.querySelector(sel);

let state = { accounts: [], history: [], rates: null };
let editing = null;          // { id, draft } while a history entry is being edited
const openIds = new Set();   // history entries currently expanded

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---------- storage ----------

async function load() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  state = data[STORAGE_KEY] || {
    accounts: [{ id: uid(), name: "", currency: "RSD", balance: 0, note: "" }],
    history: [],
  };
  state.rates ??= null;
}

let saveTimer;
function persist(immediate = false) {
  clearTimeout(saveTimer);
  const write = async () => {
    state.updatedAt = new Date().toISOString();
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
    $("#saved-indicator").textContent = "Saved " + new Date().toLocaleTimeString();
    scheduleUpload();
  };
  if (immediate) return write();
  $("#saved-indicator").textContent = "Saving…";
  saveTimer = setTimeout(write, 400);
}

// ---------- Google Drive sync ----------

let sync = { enabled: false, fileId: null, email: null };
let uploadTimer;
let syncing = false;

const clientIdMissing = () =>
  (chrome.runtime.getManifest().oauth2?.client_id || "").startsWith("REPLACE_");

function setSyncStatus(text, isError = false) {
  const s = $("#sync-status");
  s.textContent = text;
  s.classList.toggle("warn", isError);
}

function renderSyncButton() {
  $("#sync-btn").textContent = sync.enabled ? "Sign out" : "Sign in with Google";
  if (!sync.enabled) setSyncStatus("Local only");
}

const saveSyncSettings = () => chrome.storage.local.set({ [SYNC_KEY]: sync });

async function getToken(interactive) {
  const res = await chrome.identity.getAuthToken({ interactive });
  const token = typeof res === "string" ? res : res?.token;
  if (!token) throw new Error("not signed in");
  return token;
}

// fetch() against Google APIs with a bearer token; retries once with a fresh token on 401.
async function gfetch(url, opts = {}, retry = true) {
  const token = await getToken(false);
  const res = await fetch(url, { ...opts, headers: { ...opts.headers, Authorization: `Bearer ${token}` } });
  if (res.status === 401 && retry) {
    await chrome.identity.removeCachedAuthToken({ token });
    return gfetch(url, opts, false);
  }
  if (!res.ok) throw new Error(`Google Drive answered HTTP ${res.status}`);
  return res;
}

async function findDriveFile() {
  const q = encodeURIComponent(`name='${DRIVE_FILE}'`);
  const res = await gfetch(`${DRIVE_API}?spaces=appDataFolder&q=${q}&fields=files(id)`);
  return (await res.json()).files?.[0]?.id || null;
}

async function createDriveFile(data) {
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({ name: DRIVE_FILE, parents: ["appDataFolder"] })], { type: "application/json" }));
  form.append("file", new Blob([JSON.stringify(data)], { type: "application/json" }));
  const res = await gfetch(`${DRIVE_UPLOAD}?uploadType=multipart&fields=id`, { method: "POST", body: form });
  return (await res.json()).id;
}

async function downloadDriveFile(id) {
  return (await gfetch(`${DRIVE_API}/${id}?alt=media`)).json();
}

async function uploadDriveFile(id, data) {
  await gfetch(`${DRIVE_UPLOAD}/${id}?uploadType=media`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

async function fetchEmail() {
  try {
    const res = await gfetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)");
    return (await res.json()).user?.emailAddress || null;
  } catch { return null; }
}

function scheduleUpload() {
  if (!sync.enabled) return;
  clearTimeout(uploadTimer);
  setSyncStatus("Syncing…");
  uploadTimer = setTimeout(pushToDrive, 1500);
}

async function pushToDrive() {
  if (!sync.enabled) return;
  if (syncing) return scheduleUpload(); // a sync is in flight; try again shortly
  syncing = true;
  try {
    if (!sync.fileId) { sync.fileId = await createDriveFile(state); await saveSyncSettings(); }
    else await uploadDriveFile(sync.fileId, state);
    setSyncStatus(`Synced${sync.email ? " to " + sync.email : ""} · ${new Date().toLocaleTimeString()}`);
  } catch (e) {
    setSyncStatus("Sync failed: " + e.message, true);
  } finally {
    syncing = false;
  }
}

// Reconcile local state with the Drive copy: whichever was changed last wins.
// `firstLink` is true right after signing in, when the user is asked before data is replaced.
async function syncWithDrive({ firstLink = false } = {}) {
  if (!sync.enabled || syncing) return;
  syncing = true;
  setSyncStatus("Syncing…");
  try {
    sync.fileId = (await findDriveFile()) || null;
    if (!sync.fileId) {
      sync.fileId = await createDriveFile(state);
    } else {
      const remote = await downloadDriveFile(sync.fileId);
      const remoteNewer = (remote.updatedAt || "") > (state.updatedAt || "");
      let useRemote = remoteNewer;
      if (firstLink && Array.isArray(remote.accounts)) {
        useRemote = confirm(
          "This Google account already has LocalWallet data" +
          (remote.updatedAt ? ` (last changed ${new Date(remote.updatedAt).toLocaleString()})` : "") +
          ".\n\nOK: use the data from Google Drive (replaces what's on this device).\n" +
          "Cancel: keep this device's data and upload it to Google Drive.");
      }
      if (useRemote && Array.isArray(remote.accounts)) {
        state = { rates: null, ...remote };
        editing = null;
        await chrome.storage.local.set({ [STORAGE_KEY]: state });
        renderAll();
      } else if (firstLink || (state.updatedAt || "") > (remote.updatedAt || "")) {
        await uploadDriveFile(sync.fileId, state);
      }
    }
    await saveSyncSettings();
    setSyncStatus(`Synced${sync.email ? " to " + sync.email : ""} · ${new Date().toLocaleTimeString()}`);
  } catch (e) {
    setSyncStatus("Sync failed: " + e.message, true);
  } finally {
    syncing = false;
  }
}

async function signIn() {
  if (clientIdMissing()) {
    alert("Google sign-in isn't configured yet: put your OAuth client ID into manifest.json (see README).");
    return;
  }
  try {
    await getToken(true);
  } catch (e) {
    setSyncStatus("Sign-in failed: " + e.message, true);
    return;
  }
  sync = { enabled: true, fileId: null, email: await fetchEmail() };
  await saveSyncSettings();
  renderSyncButton();
  await syncWithDrive({ firstLink: true });
}

async function signOut() {
  if (!confirm("Stop syncing with Google Drive? Your data stays on this device and in Drive.")) return;
  clearTimeout(uploadTimer);
  try {
    const token = await getToken(false);
    await chrome.identity.removeCachedAuthToken({ token });
    fetch("https://oauth2.googleapis.com/revoke?token=" + token, { method: "POST" }).catch(() => {});
  } catch { /* already signed out */ }
  sync = { enabled: false, fileId: null, email: null };
  await saveSyncSettings();
  renderSyncButton();
}

// ---------- helpers ----------

// Accepts "1'234.56", "1,234.56", "1 234.56", "-50"
function parseAmount(str) {
  const n = parseFloat(String(str).replace(/[\s',]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function fmt(n, currency) {
  const s = n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${s} ${currency}` : s;
}

// Map common spellings to ISO codes so DIN and RSD land in the same bucket.
const CUR_ALIASES = { DIN: "RSD", DINAR: "RSD", DINARA: "RSD", "€": "EUR", EURO: "EUR", $: "USD", CHF: "CHF" };
const normCur = (c) => {
  const u = String(c || "").trim().toUpperCase();
  return CUR_ALIASES[u] || u || "?";
};

function totalsOf(accounts) {
  const totals = {};
  for (const a of accounts) {
    const cur = normCur(a.currency);
    totals[cur] = (totals[cur] || 0) + (Number(a.balance) || 0);
  }
  return totals;
}

const localDate = (d = new Date()) => d.toLocaleDateString("sv-SE"); // YYYY-MM-DD in local time
const prettyDate = (ymd) => new Date(ymd + "T12:00:00").toLocaleDateString();

function toLocalInput(iso) {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "className") node.className = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

// ---------- exchange rates ----------

async function fetchRates(date = "today") {
  const res = await fetch(RATES_API + date);
  if (!res.ok) throw new Error(`rate service answered HTTP ${res.status}`);
  const json = await res.json();
  const map = { RSD: 1 };
  for (const r of json.rates || []) {
    if (r.exchange_middle) map[r.code] = r.exchange_middle / (r.parity || 1);
  }
  if (!map.EUR) throw new Error("no EUR rate in response");
  return { date: json.rates[0].date, fetchedAt: new Date().toISOString(), map };
}

const ratesAreFresh = () =>
  state.rates && localDate(new Date(state.rates.fetchedAt)) === localDate();

async function refreshRates({ silent = false } = {}) {
  const btn = $("#fetch-rates");
  btn.disabled = true;
  $("#rates-info").textContent = "Fetching NBS rates…";
  try {
    state.rates = await fetchRates();
    persist(true);
  } catch (e) {
    btn.disabled = false;
    const showError = !silent || !state.rates;
    renderTotals(showError);
    if (showError) $("#rates-info").textContent = "Couldn't fetch rates: " + e.message;
    return false;
  }
  btn.disabled = false;
  renderTotals();
  return true;
}

// Convert per-currency totals into one RSD figure (and EUR via the EUR rate).
function grandTotal(accounts, rates) {
  if (!rates) return null;
  let rsd = 0;
  const missing = [];
  for (const [cur, amount] of Object.entries(totalsOf(accounts))) {
    const r = rates.map[cur];
    if (r == null) { if (amount) missing.push(cur); continue; }
    rsd += amount * r;
  }
  return { rsd, eur: rsd / rates.map.EUR, missing };
}

function grandTotalNode(accounts, rates) {
  const g = grandTotal(accounts, rates);
  if (!g) return null;
  return el("div", { className: "grand" },
    el("span", { className: "label" }, "Total"),
    el("strong", {}, fmt(g.rsd, "RSD")),
    el("span", { className: "sep" }, "·"),
    el("strong", {}, fmt(g.eur, "EUR")),
    g.missing.length
      ? el("span", { className: "warn" }, ` (excludes ${g.missing.join(", ")} — no NBS rate)`)
      : null,
  );
}

// ---------- shared account row (main table + history editor) ----------

function accountRow(acc, onChange, onRemove) {
  const field = (key, cls = "", placeholder = "") => {
    const input = el("input", { className: cls, placeholder });
    input.value = key === "balance" ? fmt(Number(acc.balance) || 0) : acc[key] ?? "";
    input.addEventListener("input", () => {
      if (key === "balance") acc.balance = parseAmount(input.value);
      else if (key === "currency") acc.currency = input.value.toUpperCase().trim();
      else acc[key] = input.value;
      onChange();
    });
    if (key === "balance") {
      input.addEventListener("focus", () => { input.value = acc.balance || ""; input.select(); });
      input.addEventListener("blur", () => { input.value = fmt(Number(acc.balance) || 0); });
    }
    return el("td", key === "balance" ? { className: "num" } : {}, input);
  };
  return el("tr", {},
    field("name", "", "e.g. Intesa"),
    field("currency", "currency", "RSD"),
    field("balance", "amount", "0.00"),
    field("note"),
    el("td", {}, el("button", { className: "icon", title: "Remove account", onclick: onRemove }, "✕")),
  );
}

// ---------- accounts table ----------

function renderAccounts() {
  const tbody = $("#accounts tbody");
  tbody.replaceChildren();
  for (const acc of state.accounts) {
    tbody.append(accountRow(acc,
      () => { renderTotals(); persist(); },
      () => {
        if (acc.name && !confirm(`Remove "${acc.name}" (${acc.currency})?`)) return;
        state.accounts = state.accounts.filter((a) => a !== acc);
        renderAccounts(); renderTotals(); persist(true);
      }));
  }
  if (!state.accounts.length) {
    tbody.append(el("tr", {}, el("td", { colspan: "5", className: "empty" }, "No accounts yet.")));
  }
}

function renderTotals(keepInfo = false) {
  const box = $("#totals");
  box.replaceChildren();
  const totals = totalsOf(state.accounts);
  const keys = Object.keys(totals).sort();
  if (!keys.length) box.append(el("span", { className: "muted" }, "—"));
  for (const cur of keys) {
    const r = state.rates?.map[cur];
    box.append(el("span", { className: "chip" },
      el("b", {}, cur), fmt(totals[cur]),
      r && cur !== "RSD" ? el("span", { className: "conv" }, `≈ ${fmt(totals[cur] * r, "RSD")}`) : null,
    ));
  }

  $("#grand-total").replaceChildren(
    grandTotalNode(state.accounts, state.rates) ||
    el("span", { className: "muted" }, "Get NBS rates to see a combined total in RSD and EUR."));

  if (!keepInfo) {
    const info = $("#rates-info");
    info.replaceChildren();
    if (state.rates) {
      const m = state.rates.map;
      info.append(
        `NBS middle rate of ${prettyDate(state.rates.date)}: 1 EUR = ${m.EUR.toFixed(4)} RSD`,
        m.USD ? `, 1 USD = ${m.USD.toFixed(4)} RSD` : "",
        " · ",
        el("a", { href: NBS_URL, target: "_blank" }, "verify on nbs.rs"),
      );
    }
  }
}

// ---------- history ----------

async function saveSnapshot() {
  const btn = $("#save-snapshot");
  btn.disabled = true;
  if (!ratesAreFresh()) await refreshRates({ silent: true }); // snapshot gets that day's rates when possible
  const noteInput = $("#snapshot-note");
  state.history.unshift({
    id: uid(),
    ts: new Date().toISOString(),
    note: noteInput.value.trim(),
    accounts: structuredClone(state.accounts),
    rates: state.rates ? structuredClone(state.rates) : null,
  });
  noteInput.value = "";
  btn.disabled = false;
  renderHistory();
  persist(true);
}

async function loadRatesForSnapshot(snap, button) {
  if (button) { button.disabled = true; button.textContent = "Fetching…"; }
  try {
    snap.rates = await fetchRates(localDate(new Date(snap.ts)));
    persist(true);
  } catch (e) {
    alert("Couldn't fetch rates for that date: " + e.message);
  }
  renderHistory();
}

function deltaNode(d, currency) {
  if (Math.abs(d) < 0.005) return null;
  return el("span", { className: "delta " + (d > 0 ? "pos" : "neg") }, (d > 0 ? "+" : "") + fmt(d, currency));
}

function renderHistory() {
  const box = $("#history");
  box.replaceChildren();
  if (!state.history.length) {
    box.append(el("div", { className: "empty" }, "No snapshots yet. Click “Save to history” to record the current balances."));
    return;
  }

  state.history.forEach((snap, i) => {
    const isEditing = editing?.id === snap.id;
    const details = el("details", {
      className: "entry" + (isEditing ? " editing" : ""),
      open: openIds.has(snap.id) || isEditing,
      ontoggle: (e) => e.target.open ? openIds.add(snap.id) : openIds.delete(snap.id),
    });
    const g = grandTotal(snap.accounts, snap.rates);

    details.append(el("summary", {},
      el("span", { className: "when" }, new Date(snap.ts).toLocaleString()),
      el("span", { className: "note" }, snap.note || ""),
      g ? el("span", { className: "sum" }, "≈ " + fmt(g.eur, "EUR")) : null,
      el("span", { className: "muted" }, `${snap.accounts.length} accounts`),
    ));
    details.append(isEditing ? historyEditor(snap) : historyView(snap, state.history[i + 1]));
    box.append(details);
  });
}

function historyView(snap, prevSnap) {
  const totals = totalsOf(snap.accounts);
  const prev = prevSnap ? totalsOf(prevSnap.accounts) : null;

  const chips = el("div", { className: "chips" });
  for (const cur of Object.keys(totals).sort()) {
    chips.append(el("span", { className: "chip" },
      el("b", {}, cur), fmt(totals[cur]),
      prev ? deltaNode(totals[cur] - (prev[cur] || 0)) : null));
  }

  let ratesLine;
  if (snap.rates) {
    const g = grandTotal(snap.accounts, snap.rates);
    const pg = prevSnap && grandTotal(prevSnap.accounts, prevSnap.rates);
    ratesLine = el("div", {},
      grandTotalNode(snap.accounts, snap.rates),
      el("div", { className: "muted" },
        `NBS rate of ${prettyDate(snap.rates.date)}: 1 EUR = ${snap.rates.map.EUR.toFixed(4)} RSD`,
        pg ? el("span", {}, " · change vs previous: ", deltaNode(g.eur - pg.eur, "EUR") || "0.00 EUR") : null));
  } else {
    const btn = el("button", { className: "small" }, `Get NBS rates for ${new Date(snap.ts).toLocaleDateString()}`);
    btn.addEventListener("click", () => loadRatesForSnapshot(snap, btn));
    ratesLine = el("div", { className: "grand" }, btn);
  }

  const rows = snap.accounts.map((a) =>
    el("tr", {},
      el("td", {}, a.name || "(unnamed)"),
      el("td", {}, a.currency),
      el("td", { className: "num" }, fmt(Number(a.balance) || 0)),
      el("td", { className: "muted" }, a.note || "")));

  return el("div", { className: "body" },
    chips,
    ratesLine,
    el("table", {},
      el("thead", {}, el("tr", {},
        el("th", {}, "Account"), el("th", {}, "Currency"),
        el("th", { className: "num" }, "Balance"), el("th", {}, "Note"))),
      el("tbody", {}, ...rows)),
    el("div", { className: "entry-actions" },
      el("button", {
        className: "small",
        onclick: () => { editing = { id: snap.id, draft: structuredClone(snap) }; renderHistory(); },
      }, "Edit"),
      el("button", {
        className: "small",
        onclick: () => {
          if (!confirm("Replace the current accounts table with this snapshot?")) return;
          state.accounts = structuredClone(snap.accounts).map((a) => ({ ...a, id: uid() }));
          renderAccounts(); renderTotals(); persist(true);
          window.scrollTo({ top: 0, behavior: "smooth" });
        },
      }, "Restore to table"),
      el("button", {
        className: "small danger",
        onclick: () => {
          if (!confirm("Delete this snapshot from history?")) return;
          state.history = state.history.filter((h) => h !== snap);
          renderHistory(); persist(true);
        },
      }, "Delete"),
    ));
}

function historyEditor(snap) {
  const draft = editing.draft;
  const tbody = el("tbody");
  const totalBox = el("div");
  const updateTotal = () => totalBox.replaceChildren(grandTotalNode(draft.accounts, draft.rates) || "");

  const fillRows = () => {
    tbody.replaceChildren();
    for (const acc of draft.accounts) {
      tbody.append(accountRow(acc, updateTotal, () => {
        draft.accounts = draft.accounts.filter((a) => a !== acc);
        fillRows(); updateTotal();
      }));
    }
  };
  fillRows(); updateTotal();

  const when = el("input", { type: "datetime-local", value: toLocalInput(draft.ts) });
  const note = el("input", { className: "grow", placeholder: "Note", value: draft.note || "" });

  const save = async (btn) => {
    const newTs = new Date(when.value);
    if (isNaN(newTs)) return alert("Please enter a valid date.");
    draft.ts = newTs.toISOString();
    draft.note = note.value.trim();
    // Date moved to another day (or no rates yet)? Re-fetch the NBS rates valid on that day.
    if (!draft.rates || localDate(newTs) !== localDate(new Date(snap.ts))) {
      btn.disabled = true; btn.textContent = "Fetching rates…";
      try { draft.rates = await fetchRates(localDate(newTs)); }
      catch { /* keep previous rates if offline */ }
    }
    Object.assign(snap, draft);
    state.history.sort((a, b) => b.ts.localeCompare(a.ts));
    editing = null;
    renderHistory(); persist(true);
  };

  const saveBtn = el("button", { className: "small primary" }, "Save changes");
  saveBtn.addEventListener("click", () => save(saveBtn));

  return el("div", { className: "body" },
    el("div", { className: "edit-meta" }, when, note),
    el("table", {},
      el("thead", {}, el("tr", {},
        el("th", {}, "Account"), el("th", {}, "Currency"),
        el("th", { className: "num" }, "Balance"), el("th", {}, "Note"), el("th", {}))),
      tbody),
    el("button", {
      className: "small",
      onclick: () => {
        const cur = draft.accounts.at(-1)?.currency || "RSD";
        draft.accounts.push({ id: uid(), name: "", currency: cur, balance: 0, note: "" });
        fillRows(); updateTotal();
        tbody.querySelector("tr:last-child input")?.focus();
      },
    }, "+ Add account"),
    totalBox,
    el("div", { className: "entry-actions" },
      saveBtn,
      el("button", { className: "small", onclick: () => { editing = null; renderHistory(); } }, "Cancel")),
  );
}

// ---------- import / export ----------

function exportJson() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = el("a", {
    href: URL.createObjectURL(blob),
    download: `localwallet-${localDate()}.json`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importJson(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.accounts) || !Array.isArray(data.history)) throw new Error("bad format");
    if (!confirm("Importing will replace all current accounts and history. Continue?")) return;
    state = { rates: null, ...data };
    editing = null;
    renderAll();
    persist(true);
  } catch {
    alert("That file doesn't look like a LocalWallet export.");
  }
}

// ---------- init ----------

function renderAll() {
  renderAccounts();
  renderTotals();
  renderHistory();
}

$("#add-row").addEventListener("click", () => {
  const lastCurrency = state.accounts.at(-1)?.currency || "RSD";
  state.accounts.push({ id: uid(), name: "", currency: lastCurrency, balance: 0, note: "" });
  renderAccounts(); renderTotals(); persist(true);
  $("#accounts tbody tr:last-child input")?.focus();
});
$("#save-snapshot").addEventListener("click", saveSnapshot);
$("#snapshot-note").addEventListener("keydown", (e) => { if (e.key === "Enter") saveSnapshot(); });
$("#fetch-rates").addEventListener("click", () => refreshRates());
$("#export").addEventListener("click", exportJson);
$("#import").addEventListener("change", (e) => {
  if (e.target.files[0]) importJson(e.target.files[0]);
  e.target.value = "";
});

$("#sync-btn").addEventListener("click", () => (sync.enabled ? signOut() : signIn()));
// Pick up changes made on another device when this tab comes back into view.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !editing) syncWithDrive();
});

load().then(async () => {
  renderAll();
  sync = (await chrome.storage.local.get(SYNC_KEY))[SYNC_KEY] || sync;
  renderSyncButton();
  await syncWithDrive();
  if (!ratesAreFresh()) refreshRates({ silent: true }); // rates refresh once per day automatically
});
