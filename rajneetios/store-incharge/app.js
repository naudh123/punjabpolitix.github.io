// Store Incharge demand queue — minimal Firebase Web SDK app (no build step).
//
// Loads Firebase config from window.RAJNEET_FIREBASE_CONFIG (see firebase-config.example.js).
// Mirrors the state machine in `firebase/firestore.rules` so the UI never offers an invalid
// transition; the rules are still the source of truth and will reject anything bad server-side.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  collectionGroup,
  query,
  where,
  orderBy,
  onSnapshot,
  doc,
  updateDoc,
  arrayUnion,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import {
  getStorage,
  ref as storageRef,
  uploadBytes,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-storage.js";

// ---------- demand state machine (must match firebase/firestore.rules) ----------

// BEGIN_GENERATED: demand-state-machine — DO NOT EDIT BY HAND
//   Source of truth: data/demand_state_machine.json
//   Regenerate    : python scripts/generate_demand_state_machine.py
//   Verified by   : tests/test_demand_state_machine_codegen.py
const TRANSITIONS = {
  draft: ["submitted", "cancelled"],
  submitted: ["in_progress", "on_hold", "rejected", "cancelled"],
  in_progress: ["on_hold", "partially_fulfilled", "fulfilled", "rejected", "cancelled"],
  on_hold: ["in_progress", "rejected", "cancelled"],
  partially_fulfilled: ["in_progress", "fulfilled", "cancelled"],
  fulfilled: [],
  rejected: [],
  cancelled: [],
};
// END_GENERATED: demand-state-machine

// ---------- demand bounds (must match firebase/firestore.rules) ----------

// BEGIN_GENERATED: demand-bounds — DO NOT EDIT BY HAND
//   Source of truth: data/demand_bounds.json
//   Regenerate    : python scripts/generate_demand_bounds.py
//   Verified by   : tests/test_demand_bounds_codegen.py
const BOUNDS = Object.freeze({
  itemMax: 80,
  quantityMin: 1,
  quantityMax: 100000,
  onHoldReasonMax: 300,
  noteMax: 500,
});
// END_GENERATED: demand-bounds

// ---------- dispatch-proof attachment caps (must match storage.rules) ----------

// BEGIN_GENERATED: dispatch-proof — DO NOT EDIT BY HAND
//   Source of truth: data/dispatch_proof.json
//   Regenerate    : python scripts/generate_dispatch_proof.py
//   Verified by   : tests/test_dispatch_proof_codegen.py
const DISPATCH_PROOF = Object.freeze({
  // Cap on dispatchProofRefs entries on the demand doc.
  maxRefs: 10,
  // 5 MiB per upload (5,242,880 bytes).
  maxBytes: 5242880,
  contentTypePrefix: "image/",
  // HTML `accept` attribute form, e.g. "image/*".
  acceptAttr: "image/*",
});
// END_GENERATED: dispatch-proof

function nextStatusOptions(current) {
  return TRANSITIONS[current] ?? [];
}

// ---------- filter chips (UI-only — server filter applies when a single status is chosen) ----------

const STATUS_CHIPS = [
  ["open", "open"],
  ["submitted", "submitted"],
  ["in_progress", "in_progress"],
  ["on_hold", "on_hold"],
  ["partially_fulfilled", "partial"],
  ["fulfilled", "fulfilled"],
  ["rejected", "rejected"],
  ["cancelled", "cancelled"],
  ["all", "all"],
];
const OPEN_STATUSES = new Set([
  "draft", "submitted", "in_progress", "on_hold", "partially_fulfilled",
]);
let currentStatusFilter = "open";

// ---------- Store Incharge role gate (must match firebase/firestore.rules) ----------

// BEGIN_GENERATED: firebase-role-gates — DO NOT EDIT BY HAND
//   Source of truth: data/firebase_custom_roles.json
//   Regenerate    : python scripts/generate_firebase_role_gates.py
//   Verified by   : tests/test_firebase_roles_codegen.py
function isStoreInchargeRole(role) {
  return role === "ac_admin" || role === "super_admin";
}

function storeInchargeRoleHint() {
  return "ac_admin or super_admin";
}
// END_GENERATED: firebase-role-gates

// ---------- DOM helpers ----------

function $(id) { return document.getElementById(id); }
function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }
function setText(el, t) { el.textContent = t; }

function boothPathFor(scope) {
  return `contracts/${scope.contractId}/cycles/${scope.cycleId}/acs/${scope.acCode}/booths/${scope.boothCode}/demands`;
}

// ---------- init ----------

const cfg = window.RAJNEET_FIREBASE_CONFIG;
if (!cfg) {
  document.body.innerHTML = "<h2>Missing firebase-config.js</h2><p>Copy <code>firebase-config.example.js</code> to <code>firebase-config.js</code> and fill in your Firebase web project config.</p>";
  throw new Error("RAJNEET_FIREBASE_CONFIG not set");
}
const app = initializeApp(cfg);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

let unsubDemands = null;
let claims = null;
let lastSnapshot = null;
let lastSnapshotAcWide = false;

// ---------- chip rendering ----------

function renderChips() {
  const root = $("status-chips");
  root.innerHTML = "";
  for (const [value, label] of STATUS_CHIPS) {
    const c = document.createElement("span");
    c.className = "chip" + (currentStatusFilter === value ? " on" : "");
    c.textContent = label;
    c.dataset.value = value;
    c.addEventListener("click", () => {
      currentStatusFilter = value;
      renderChips();
      // Re-query when the filter has a server-side counterpart (single named status).
      reloadActiveQuery();
    });
    root.appendChild(c);
  }
}
renderChips();

// ---------- login ----------

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("email").value.trim();
  const password = $("password").value;
  const errEl = $("login-error");
  setText(errEl, "");
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (e) {
    setText(errEl, e.message || String(e));
  }
});

$("logout").addEventListener("click", async () => {
  await signOut(auth);
});

onAuthStateChanged(auth, async (user) => {
  if (unsubDemands) { unsubDemands(); unsubDemands = null; }
  if (!user) {
    show($("login-card"));
    hide($("main-card"));
    setText($("who"), "");
    return;
  }
  const tok = await user.getIdTokenResult(true);
  claims = tok.claims;
  setText($("who"), `${user.email ?? user.uid} · role=${claims.role ?? "(none)"} · contract=${claims.contractId ?? "(none)"} · ACs=${(claims.acCodes ?? []).join(",")}`);
  if (!isStoreInchargeRole(claims.role)) {
    hide($("main-card"));
    show($("login-card"));
    setText(
      $("login-error"),
      `Your account is not a Store Incharge (role must be ${storeInchargeRoleHint()}). Ask an admin to set claims via scripts/set_booth_incharge_claims.ps1.`,
    );
    return;
  }
  hide($("login-card"));
  show($("main-card"));
  if (claims.contractId) $("contractId").value = claims.contractId;
  if (claims.cycleId) $("cycleId").value = claims.cycleId;
  if (Array.isArray(claims.acCodes) && claims.acCodes.length > 0 && !$("acCode").value) {
    $("acCode").value = claims.acCodes[0];
  }
});

// ---------- queue mode ----------

function readScope(requireBooth) {
  const scope = {
    contractId: $("contractId").value.trim(),
    cycleId: $("cycleId").value.trim(),
    acCode: $("acCode").value.trim(),
    boothCode: $("boothCode").value.trim(),
  };
  const required = ["contractId", "cycleId", "acCode"].concat(requireBooth ? ["boothCode"] : []);
  for (const k of required) {
    if (!scope[k]) return { scope, error: `${k} is required.` };
  }
  return { scope, error: null };
}

let activeReload = null;

function reloadActiveQuery() {
  if (activeReload) activeReload();
}

function statusFilterIsSingle() {
  return currentStatusFilter !== "open" && currentStatusFilter !== "all";
}

$("load-booth").addEventListener("click", () => {
  const { scope, error } = readScope(true);
  if (error) { setText($("load-error"), error); return; }
  setText($("load-error"), "");
  activeReload = () => loadBooth(scope);
  loadBooth(scope);
});

function loadBooth(scope) {
  if (unsubDemands) unsubDemands();
  const col = collection(db, boothPathFor(scope));
  const constraints = [orderBy("createdAt", "desc")];
  if (statusFilterIsSingle()) {
    constraints.unshift(where("status", "==", currentStatusFilter));
  }
  const q = query(col, ...constraints);
  unsubDemands = onSnapshot(
    q,
    (snap) => {
      lastSnapshot = snap; lastSnapshotAcWide = false;
      renderDemands(snap, { acWide: false });
    },
    (err) => setText($("load-error"), `Firestore error: ${err.message}`),
  );
}

$("load-ac").addEventListener("click", () => {
  const { scope, error } = readScope(false);
  if (error) { setText($("load-error"), error); return; }
  setText($("load-error"), "");
  activeReload = () => loadAc(scope);
  loadAc(scope);
});

function loadAc(scope) {
  if (unsubDemands) unsubDemands();
  // collectionGroup query — see firebase/firestore.indexes.json for composite indexes.
  const constraints = [
    where("contractId", "==", scope.contractId),
    where("acCode", "==", scope.acCode),
  ];
  if (statusFilterIsSingle()) {
    constraints.push(where("status", "==", currentStatusFilter));
  }
  constraints.push(orderBy("createdAt", "desc"));
  const q = query(collectionGroup(db, "demands"), ...constraints);
  unsubDemands = onSnapshot(
    q,
    (snap) => {
      lastSnapshot = snap; lastSnapshotAcWide = true;
      renderDemands(snap, { acWide: true });
    },
    (err) => setText($("load-error"), `Firestore error: ${err.message}\n\nIf this is "FAILED_PRECONDITION", deploy the composite indexes from firebase/firestore.indexes.json:\n  firebase deploy --only firestore:indexes`),
  );
}

function applyClientFilter(docs) {
  if (currentStatusFilter === "all") return docs;
  if (currentStatusFilter === "open") {
    return docs.filter((d) => OPEN_STATUSES.has((d.data().status || "")));
  }
  // Single-status case is already enforced server-side, but keep the filter defensive
  // for cached snapshots after a chip change.
  return docs.filter((d) => (d.data().status || "") === currentStatusFilter);
}

function renderDemands(snap, { acWide }) {
  const root = $("demands");
  root.innerHTML = "";
  const filtered = applyClientFilter(snap.docs);
  setText($("result-count"), `${filtered.length} of ${snap.size}`);
  if (filtered.length === 0) {
    root.innerHTML = `<p><em>No demands match the current filter.</em></p>`;
    return;
  }
  for (const d of filtered) {
    const data = d.data();
    const row = document.createElement("div");
    row.className = "demand";
    const boothLabel = acWide ? ` · booth <code>${escapeHtml(data.boothCode ?? "?")}</code>` : "";
    const proofsBlock = renderProofs(data.dispatchProofRefs);
    row.innerHTML = `
      <div class="head">
        <strong>${escapeHtml(data.item ?? "(no item)")} × ${data.quantity ?? "?"}</strong>
        <span class="status status-${escapeHtml(data.status ?? "unknown")}">${escapeHtml(data.status ?? "unknown")}</span>
      </div>
      <div class="meta">
        id <code>${escapeHtml(d.id)}</code>${boothLabel} · createdBy <code>${escapeHtml(data.createdBy ?? "")}</code> · createdAt ${escapeHtml(data.createdAt ?? "")}
        ${data.updatedAt ? ` · updatedAt ${escapeHtml(data.updatedAt)} by <code>${escapeHtml(data.updatedBy ?? "")}</code>` : ""}
        ${typeof data.fulfilledQty === "number" ? ` · fulfilledQty ${data.fulfilledQty}` : ""}
        ${data.onHoldReason ? `<br/>on hold: ${escapeHtml(data.onHoldReason)}` : ""}
        ${data.note ? `<br/>note: ${escapeHtml(data.note)}` : ""}
      </div>
      ${proofsBlock}
    `;
    appendTransitionForm(row, d, data);
    appendUploadForm(row, d, data);
    root.appendChild(row);
  }
}

function renderProofs(refs) {
  if (!Array.isArray(refs) || refs.length === 0) return "";
  const items = refs.map((r) => `<li><code>${escapeHtml(r)}</code></li>`).join("");
  return `<div class="proofs"><strong>dispatch proof (${refs.length}):</strong><ul>${items}</ul></div>`;
}

function appendTransitionForm(row, d, data) {
  const next = nextStatusOptions(data.status);
  if (next.length === 0) {
    const term = document.createElement("p");
    term.className = "terminal";
    term.textContent = "Terminal status — no transitions available.";
    row.appendChild(term);
    return;
  }
  const form = document.createElement("form");
  form.className = "transition";
  form.innerHTML = `
    <label>Move to
      <select data-field="status">
        ${next.map((s) => `<option value="${s}">${s}</option>`).join("")}
      </select>
    </label>
    <label>fulfilledQty
      <input data-field="fulfilledQty" type="number" min="0" max="${data.quantity ?? ""}" placeholder="optional" />
    </label>
    <label>onHoldReason / note
      <input data-field="reason" type="text" maxlength="${BOUNDS.onHoldReasonMax}" placeholder="optional, used as onHoldReason for on_hold, note for fulfilled/rejected" />
    </label>
    <button type="submit">Save</button>
    <span class="row-msg"></span>
  `;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const sel = form.querySelector("[data-field='status']");
    const qty = form.querySelector("[data-field='fulfilledQty']");
    const reason = form.querySelector("[data-field='reason']");
    const msg = form.querySelector(".row-msg");
    const to = sel.value;
    msg.textContent = "Saving…";
    try {
      const payload = {
        status: to,
        updatedBy: auth.currentUser.uid,
        updatedAt: new Date().toISOString(),
      };
      const qtyVal = qty.value.trim();
      if (qtyVal !== "") {
        const n = Number.parseInt(qtyVal, 10);
        if (!Number.isFinite(n) || n < 0) throw new Error("fulfilledQty must be a non-negative integer.");
        payload.fulfilledQty = n;
      }
      const rText = reason.value.trim();
      if (rText !== "") {
        if (to === "on_hold") payload.onHoldReason = rText;
        else payload.note = rText;
      }
      await updateDoc(d.ref, payload);
      msg.textContent = "Saved.";
    } catch (e) {
      msg.textContent = `Error: ${e.message || e}`;
    }
  });
  row.appendChild(form);
}

function appendUploadForm(row, d, data) {
  const form = document.createElement("form");
  form.className = "upload";
  form.innerHTML = `
    <label>Add dispatch proof
      <input type="file" data-field="file" accept="${DISPATCH_PROOF.acceptAttr}" />
    </label>
    <button type="submit">Upload</button>
    <span class="row-msg"></span>
  `;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = form.querySelector("[data-field='file']");
    const msg = form.querySelector(".row-msg");
    const f = input.files?.[0];
    if (!f) { msg.textContent = "Pick a file first."; return; }
    if (f.size > DISPATCH_PROOF.maxBytes) {
      msg.textContent = `File must be ≤ ${(DISPATCH_PROOF.maxBytes / (1024 * 1024)).toFixed(0)} MB.`;
      return;
    }
    if (!f.type.startsWith(DISPATCH_PROOF.contentTypePrefix)) {
      msg.textContent = `Only ${DISPATCH_PROOF.acceptAttr} uploads are allowed.`;
      return;
    }
    msg.textContent = "Uploading…";
    try {
      const existing = Array.isArray(data.dispatchProofRefs) ? data.dispatchProofRefs.length : 0;
      if (existing >= DISPATCH_PROOF.maxRefs) {
        throw new Error(`dispatchProofRefs is capped at ${DISPATCH_PROOF.maxRefs} entries.`);
      }
      const safeName = f.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
      const path = `dispatch-proof/${data.contractId}/${data.cycleId}/${data.acCode}/${data.boothCode}/${d.id}/${Date.now()}_${safeName}`;
      const ref = storageRef(storage, path);
      await uploadBytes(ref, f, { contentType: f.type });
      await updateDoc(d.ref, {
        dispatchProofRefs: arrayUnion(path),
        updatedBy: auth.currentUser.uid,
        updatedAt: new Date().toISOString(),
      });
      msg.textContent = "Uploaded.";
      input.value = "";
    } catch (e) {
      msg.textContent = `Error: ${e.message || e}`;
    }
  });
  row.appendChild(form);
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
