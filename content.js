/* IMIS Sync — content script for Bahmni Registration
   Injects an "IMIS Sync" button after "Create New" in the header.
   Clicking reads the NHIS Number from the Insurance Details form and
   shows the patient's IMIS status using the existing PHP endpoints. */
(function () {
  "use strict";

  var NHIS_INPUT_ID = "NHIS Number";
  var ELIGIBILITY_URL = "/insurance/Eligibility.php?identifier=";
  var PATIENT_URL = "/insurance/Patient.php?identifier=";
  var TIMEOUT_MS = 20000;

  var buttonAdded = false;
  var overlay = null;
  var toastTimer = null;

  /* ---------------- Button injection ---------------- */

  function ensureButton() {
    // Already injected and still in the DOM (SPA re-renders remove it -> we re-add)
    if (document.getElementById("imis-sync-button")) return true;

    var nav = document.querySelector(".reg-header .top-nav");
    if (!nav) return false;

    var items = nav.querySelectorAll("li");
    var createNewLi = null;
    for (var i = 0; i < items.length; i++) {
      var span = items[i].querySelector("span.nav-link");
      if (span && /create/i.test(span.textContent)) {
        createNewLi = items[i];
        break;
      }
    }
    if (!createNewLi) return false;

    var li = document.createElement("li");
    var a = document.createElement("a");
    a.id = "imis-sync-button";
    a.href = "javascript:void(0)";
    a.style.cursor = "pointer";
    a.innerHTML = '<i class="fa fa-refresh fa-white small"></i><span class="nav-link">IMIS <u>S</u>ync</span>';
    a.addEventListener("click", onSyncClick);
    li.appendChild(a);
    createNewLi.parentNode.insertBefore(li, createNewLi.nextSibling);
    return true;
  }

  // The Angular header renders shortly after load; retry until it exists.
  var attempts = 0;
  var retry = window.setInterval(function () {
    if (ensureButton() || attempts > 120) window.clearInterval(retry);
    attempts++;
  }, 250);

  // Bahmni is a single-page app: Angular re-renders the header on navigation,
  // which removes our button. Watch the DOM and put it back whenever it vanishes.
  var observer = new MutationObserver(function () { ensureButton(); });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  /* ---------------- Click handler ---------------- */

  function onSyncClick(e) {
    e.preventDefault();
    var nhisInput = document.getElementById(NHIS_INPUT_ID);
    if (!nhisInput) {
      showToast("NHIS Number field not found. Open the Insurance Details section first.");
      return;
    }
    var nhis = (nhisInput.value || "").trim();
    if (!nhis) {
      showToast("Please enter NHIS Number in the Insurance Details section.");
      return;
    }
    runCheck(nhis);
  }

  function runCheck(nhis) {
    showOverlayLoading(nhis);
    Promise.all([
      fetchJson(ELIGIBILITY_URL + encodeURIComponent(nhis)),
      fetchJson(PATIENT_URL + encodeURIComponent(nhis))
    ]).then(function (results) {
      renderOverlay(nhis, results[0], results[1]);
    }).catch(function (err) {
      var msg = (err && err.name === "AbortError")
        ? "Request timed out. Check your connection to the hospital network."
        : ((err && err.message) || "Unknown error");
      showOverlayError(nhis, msg);
    });
  }

  function fetchJson(url) {
    var controller = new AbortController();
    var timer = window.setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
    return fetch(url, { signal: controller.signal, credentials: "same-origin" })
      .then(function (resp) {
        if (!resp.ok) throw new Error("Server returned HTTP " + resp.status);
        return resp.json();
      })
      .finally(function () { window.clearTimeout(timer); });
  }

  /* ---------------- Parsing ---------------- */

  function getExtensionValue(extensions, pattern) {
    if (!Array.isArray(extensions)) return "";
    for (var i = 0; i < extensions.length; i++) {
      var url = extensions[i] && extensions[i].url ? extensions[i].url : "";
      if (pattern.test(url) && extensions[i].valueString) return extensions[i].valueString;
    }
    return "";
  }

  function parseEligibility(data) {
    var result = { active: false, coPayment: null, diseaseName: null, photoUrl: "", balances: [] };
    if (!data) return result;
    result.coPayment = data.coPayment != null ? data.coPayment : null;
    result.diseaseName = data.diseaseName || null;
    var elig = data.eligibility || {};
    result.photoUrl = getExtensionValue(elig.extension, /Photo.*Url/i);
    var insurance = Array.isArray(elig.insurance) ? elig.insurance : [];
    result.active = insurance.length > 0;
    insurance.forEach(function (ins) {
      var contract = (ins.contract && ins.contract.reference) || "";
      var validTill = contract.split("/").pop() || "N/A";
      var copayExt = null;
      (ins.extension || []).forEach(function (ext) {
        if (ext && ext.url && /Copayment/i.test(ext.url)) copayExt = ext;
      });
      var insCopay = copayExt
        ? (copayExt.valueDecimal != null ? copayExt.valueDecimal : copayExt.valueString)
        : null;
      (ins.benefitBalance || []).forEach(function (b) {
        var fin = (b.financial || [])[0] || {};
        var allowed = fin.allowedMoney && fin.allowedMoney.value != null ? fin.allowedMoney.value : 0;
        var used = fin.usedMoney && fin.usedMoney.value != null ? fin.usedMoney.value : 0;
        result.balances.push({
          category: (b.category && b.category.text) || "N/A",
          allowed: allowed,
          used: used,
          validTill: validTill,
          copay: insCopay != null ? insCopay : result.coPayment
        });
      });
    });
    return result;
  }

  function parsePatient(data) {
    if (!data || !Array.isArray(data.entry) || !data.entry.length) return null;
    var r = data.entry[0].resource || {};
    var nameObj = (r.name || [])[0] || {};
    var given = Array.isArray(nameObj.given) ? nameObj.given.join(" ") : (nameObj.given || "");
    var telecom = r.telecom || [];
    var phone = "", email = "";
    for (var i = 0; i < telecom.length; i++) {
      if (telecom[i].system === "phone" && !phone) phone = telecom[i].value || "";
      if (telecom[i].system === "email" && !email) email = telecom[i].value || "";
    }
    var addr = (r.address || [])[0] || {};
    return {
      name: [given, nameObj.family || ""].filter(Boolean).join(" ").trim(),
      birthDate: r.birthDate || "",
      gender: r.gender || "",
      phone: phone,
      email: email,
      address: addr.text || "",
      district: getExtensionValue(r.extension, /District/i),
      photoUrl: getExtensionValue(r.extension, /Photo.*Url/i)
    };
  }

  function calcAge(birthDate) {
    if (!birthDate) return "";
    var b = new Date(birthDate);
    if (isNaN(b.getTime())) return "";
    var now = new Date();
    var age = now.getFullYear() - b.getFullYear();
    var m = now.getMonth() - b.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
    return age >= 0 ? String(age) : "";
  }

  /* ---------------- Overlay UI ---------------- */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function showOverlayLoading(nhis) {
    removeOverlay();
    overlay = el("div", "imis-overlay");
    var modal = el("div", "imis-modal");
    var head = el("div", "imis-head");
    head.appendChild(el("span", "imis-title", "IMIS Sync"));
    var close = el("button", "imis-close", "\u00d7");
    close.addEventListener("click", removeOverlay);
    head.appendChild(close);
    var body = el("div", "imis-body");
    body.appendChild(el("div", "imis-loading", "Checking eligibility for NHIS " + nhis + " \u2026"));
    modal.appendChild(head);
    modal.appendChild(body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  function showOverlayError(nhis, msg) {
    var body = overlay ? overlay.querySelector(".imis-body") : null;
    if (!body) return;
    body.innerHTML = "";
    body.appendChild(el("div", "imis-error", "Could not reach IMIS server: " + msg));
  }

  function renderOverlay(nhis, eligData, patData) {
    var body = overlay ? overlay.querySelector(".imis-body") : null;
    if (!body) return;
    body.innerHTML = "";

    var elig = parseEligibility(eligData);
    var patient = parsePatient(patData);
    var name = patient ? patient.name : "";
    var title = overlay.querySelector(".imis-title");
    if (title) title.textContent = name ? "IMIS Sync \u2014 " + name : "IMIS Sync";

    /* patient info grid */
    var grid = el("div", "imis-grid");
    var photoCell = el("div", "imis-photo");
    var photoUrl = elig.photoUrl || (patient ? patient.photoUrl : "");
    var avatar = initialAvatar(name || nhis);
    if (photoUrl) {
      var img = document.createElement("img");
      img.src = photoUrl;
      img.alt = "photo";
      img.onerror = function () { img.replaceWith(avatar); };
      photoCell.appendChild(img);
    } else {
      photoCell.appendChild(avatar);
    }
    grid.appendChild(photoCell);
    addInfoCard(grid, "NHIS", nhis);
    addInfoCard(grid, "Name", name || "-");
    var ageGender = [calcAge(patient && patient.birthDate), patient && patient.gender].filter(Boolean).join(" / ");
    addInfoCard(grid, "Age / Gender", ageGender || "-");
    addInfoCard(grid, "Phone", (patient && patient.phone) || "-");
    body.appendChild(grid);

    /* status row */
    var statusRow = el("div", "imis-status-row");
    var statusGroup = el("div", "imis-status-group");
    statusGroup.appendChild(el("span", "imis-label", "Policy Status:"));
    var badge = el("span",
      elig.active ? "imis-badge imis-badge-active" : "imis-badge imis-badge-inactive",
      elig.active ? "ACTIVE" : "INACTIVE");
    statusGroup.appendChild(badge);
    statusRow.appendChild(statusGroup);
    if (elig.coPayment != null) {
      var copayYes = Number(elig.coPayment) > 0;
      statusRow.appendChild(el("span",
        copayYes ? "imis-copay imis-copay-yes" : "imis-copay imis-copay-no",
        "Co-Payment: " + (copayYes ? "Yes" : "No")));
    }
    if (elig.diseaseName) {
      statusRow.appendChild(el("span", "imis-disease", "Disease: " + elig.diseaseName));
    }
    body.appendChild(statusRow);

    /* balances */
    body.appendChild(el("div", "imis-section-title", "Eligibility / Claim Info"));
    if (!elig.balances.length) {
      body.appendChild(el("div", "imis-nodata", "No eligibility data for this NHIS number."));
    } else {
      elig.balances.forEach(function (b) {
        var card = el("div", "imis-balance");
        addInfoCell(card, "Category", b.category);
        addInfoCell(card, "Allowed Balance", "Rs. " + formatMoney(b.allowed));
        addInfoCell(card, "Used Balance", "Rs. " + formatMoney(b.used));
        addInfoCell(card, "Valid Till", b.validTill);
        body.appendChild(card);
      });
    }
  }

  function addInfoCard(parent, label, value) {
    var card = el("div", "imis-card");
    card.appendChild(el("div", "imis-label", label));
    card.appendChild(el("div", "imis-value", value));
    parent.appendChild(card);
  }

  function addInfoCell(parent, label, value) {
    var cell = el("div", "imis-cell");
    cell.appendChild(el("div", "imis-label", label));
    cell.appendChild(el("div", "imis-value", value));
    parent.appendChild(cell);
  }

  function initialAvatar(text) {
    return el("div", "imis-avatar", (text || "?").trim().charAt(0).toUpperCase());
  }

  function formatMoney(v) {
    var n = Number(v);
    if (isNaN(n)) return "0.00";
    return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function showToast(msg) {
    var t = document.getElementById("imis-toast");
    if (!t) {
      t = el("div", "imis-toast");
      t.id = "imis-toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = "imis-toast imis-toast-show";
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () { t.className = "imis-toast"; }, 4500);
  }

  function removeOverlay() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
  }
})();
