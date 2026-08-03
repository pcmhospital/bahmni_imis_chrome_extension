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
      givenName: given,
      familyName: nameObj.family || "",
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
    overlay.addEventListener("click", function (e) { if (e.target === overlay) removeOverlay(); });
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

    /* sync: which fields differ + one button to sync all */
    var syncDiffs = patient ? compareFields(patient, elig.active, nhis) : [];
    var syncSection = el("div", "imis-sync-section");
    if (syncDiffs.length) {
      syncSection.appendChild(el("div", "imis-sync-title", "Sync \u2014 " + syncDiffs.length + " field" + (syncDiffs.length === 1 ? "" : "s") + " differ from IMIS:"));
      syncDiffs.forEach(function (d) {
        syncSection.appendChild(el("div", "imis-sync-item", "\u2022 " + d.label));
      });
      var syncBtn = document.createElement("button");
      syncBtn.type = "button";
      syncBtn.className = "imis-sync-all-btn";
      syncBtn.textContent = "Sync All from IMIS";
      syncBtn.addEventListener("click", function () {
        syncDiffs.forEach(function (d) { d.apply(); });
        syncSection.innerHTML = "";
        syncSection.appendChild(el("div", "imis-sync-done", "\u2713 All fields synced from IMIS."));
        showToast("All fields synced from IMIS.");
      });
      syncSection.appendChild(syncBtn);
    } else if (patient) {
      syncSection.appendChild(el("div", "imis-sync-done", "All fields match IMIS \u2014 nothing to sync."));
    }
    body.appendChild(syncSection);
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

  /* ---------------- Sync-with-IMIS (field-level compare) ----------------
     Compare the IMIS patient data against the Bahmni registration form.
     Returns an array of diffs: { label, apply } where apply() fills that
     single field. Address and Claim Id are intentionally skipped. */

  var SYNC_FIELD_SPECS = [
    { ids: ["givenName", "given name", "Given Name", "firstname", "FirstName"], labelRe: /given\s*name|first\s*name|firstname/i },
    { ids: ["familyName", "family name", "Family Name", "lastname", "LastName", "surname"], labelRe: /family\s*name|last\s*name|lastname|surname/i },
    { ids: ["gender", "Gender", "sex", "Sex"], labelRe: /^\s*gender\s*$|^\s*sex\s*$/i },
    { ids: ["ageYears", "ageYear", "Year", "year", "Age Year", "Birth Year"], labelRe: /age|years|year/i },
    { ids: ["Contact Number", "contact number", "Phone Number", "phoneNumber", "PhoneNumber", "telephone"], labelRe: /contact\s*number|phone|telephone|mobile/i },
    { ids: [NHIS_INPUT_ID, "nhis", "NHIS", "insurance number"], labelRe: /nhis|insurance\s*number/i }
  ];

  function locateField(spec) {
    var ctrl = null;
    for (var i = 0; i < spec.ids.length && !ctrl; i++) {
      ctrl = document.getElementById(spec.ids[i]);
    }
    if (!ctrl) {
      var labels = document.querySelectorAll("label");
      for (var j = 0; j < labels.length && !ctrl; j++) {
        var txt = labels[j].textContent || "";
        if (spec.labelRe.test(txt)) {
          var forId = labels[j].htmlFor;
          if (forId && document.getElementById(forId)) {
            ctrl = document.getElementById(forId);
          } else {
            var wrap = labels[j].closest(".field-group, .control-group, .field, .item");
            if (wrap) ctrl = wrap.querySelector("input, select, textarea");
          }
        }
      }
    }
    return ctrl && ctrl.disabled === false ? ctrl : null;
  }

  function normText(s) {
    return String(s || "").toUpperCase().replace(/\s+/g, " ").trim();
  }

  function titleCase(s) {
    return String(s || "").toLowerCase().replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function digitsOnly(s) {
    return String(s || "").replace(/[^\d]/g, "");
  }

  function parseAnyDate(s) {
    if (!s) return null;
    var str = String(s).trim();
    var m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return { y: +m[1], mo: +m[2], d: +m[3] };
    m = str.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    if (m) return { y: +m[3], mo: +m[2], d: +m[1] };
    m = str.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/);
    if (m) return { y: 2000 + +m[3], mo: +m[2], d: +m[1] };
    return null;
  }

  function dateToForm(iso) {
    if (!iso) return "";
    var p = String(iso).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!p) return iso;
    return p[3] + "-" + p[2] + "-" + p[1];
  }

  function normalizeGender(s) {
    var t = normText(s);
    if (t === "M" || t === "MALE") return "M";
    if (t === "F" || t === "FEMALE") return "F";
    if (t === "O" || t === "OTHER") return "O";
    return t;
  }

  function dispatchEvents(ctrl) {
    ["input", "change"].forEach(function (type) {
      try { ctrl.dispatchEvent(new Event(type, { bubbles: true })); } catch (e) { /* noop */ }
    });
  }

  function setTextValue(ctrl, value) {
    ctrl.value = value;
    dispatchEvents(ctrl);
  }

  function chooseOption(ctrl, imisText, truthy) {
    if (!ctrl || !ctrl.options) return false;
    var opts = ctrl.options;
    for (var i = 0; i < opts.length; i++) {
      if (normText(opts[i].text) === normText(imisText) || normText(opts[i].value) === normText(imisText)) {
        ctrl.value = opts[i].value;
        dispatchEvents(ctrl);
        return true;
      }
    }
    if (truthy != null) {
      var yes = null, no = null;
      for (var k = 0; k < opts.length; k++) {
        if (/yes|true|active|^1$/.test(normText(opts[k].text))) yes = opts[k];
        else if (/no|false|inactive|^0$/.test(normText(opts[k].text))) no = opts[k];
      }
      var target = truthy ? (yes || no) : (no || yes);
      if (target) { ctrl.value = target.value; dispatchEvents(ctrl); return true; }
    }
    return false;
  }

  function compareFields(patient, active, nhis) {
    if (!patient) return [];

    var givC = locateField(SYNC_FIELD_SPECS[0]);
    var famC = locateField(SYNC_FIELD_SPECS[1]);
    var genderC = locateField(SYNC_FIELD_SPECS[2]);
    var yearC = locateField(SYNC_FIELD_SPECS[3]);
    var phoneC = locateField(SYNC_FIELD_SPECS[4]);
    var nhisC = locateField(SYNC_FIELD_SPECS[5]);
    var diffs = [];

    function add(label, fn) { diffs.push({ label: label, apply: fn }); }

    // Name (title-cased)
    if (givC) {
      var formName = [givC.value, famC ? famC.value : ""].filter(Boolean).join(" ");
      if (normText(formName) !== normText(patient.name)) {
        add("Name", function () {
          setTextValue(givC, titleCase(patient.givenName || ""));
          if (famC) setTextValue(famC, titleCase(patient.familyName || ""));
        });
      }
    }

    // Gender
    if (genderC) {
      var imisG = normalizeGender(patient.gender);
      if (imisG && normText(genderC.value) !== imisG) {
        add("Gender", function () {
          if (genderC.tagName === "SELECT") chooseOption(genderC, patient.gender);
          else setTextValue(genderC, imisG);
        });
      }
    }

    // Age in years (computed from IMIS birthDate)
    if (yearC) {
      var imisAge = calcAge(patient.birthDate);
      var curYear = String(yearC.value).trim();
      if (imisAge && curYear !== imisAge) {
        add("Age", function () {
          setTextValue(yearC, imisAge);
          showToast("Age synced as " + imisAge + " years.");
        });
      }
    }

    // Phone
    if (phoneC) {
      if (patient.phone && digitsOnly(phoneC.value) !== digitsOnly(patient.phone)) {
        add("Phone", function () { setTextValue(phoneC, patient.phone); });
      }
    }

    // NHIS number
    if (nhisC) {
      if (digitsOnly(nhisC.value) !== digitsOnly(nhis)) {
        add("NHIS Number", function () { setTextValue(nhisC, nhis); });
      }
    }

    return diffs;
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
