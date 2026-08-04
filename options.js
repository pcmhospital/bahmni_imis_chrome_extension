const STATUS_URL = "https://api.github.com/repos/pcmhospital/bahmni_imis_chrome_extension/contents/version.json";

function showStatus(msg, ok) {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.className = "status " + (ok ? "status-ok" : "status-err");
}

// Load saved token
chrome.storage.local.get("githubToken", function (res) {
  if (res.githubToken) {
    document.getElementById("token").value = res.githubToken;
  }
});

// Save
document.getElementById("save").addEventListener("click", function () {
  const token = document.getElementById("token").value.trim();
  chrome.storage.local.set({ githubToken: token }, function () {
    showStatus("Token saved.", true);
  });
});

// Test
document.getElementById("test").addEventListener("click", function () {
  const token = document.getElementById("token").value.trim();
  if (!token) { showStatus("Enter a token first.", false); return; }
  showStatus("Testing...", true);
  fetch(STATUS_URL, {
    headers: { "Authorization": "Bearer " + token, "Accept": "application/vnd.github.v3+json" }
  }).then(function (r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }).then(function () {
    showStatus("Connection OK — token works.", true);
  }).catch(function (e) {
    showStatus("Failed: " + (e.message || "unknown error"), false);
  });
});
