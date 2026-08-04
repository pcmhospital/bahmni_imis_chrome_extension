/* IMIS Sync — update checker (Manifest V3 service worker).
   Polls a version.json via the jsDelivr CDN mirror of the GitHub repo
   and notifies the user when a newer version is published.
   It only reads version metadata — it never fetches or executes remote code. */
(function () {
  "use strict";

  const VERSION_URL = "https://api.github.com/repos/pcmhospital/bahmni_imis_chrome_extension/contents/version.json";
  const CHECK_INTERVAL_MINUTES = 240;
  const ALARM_NAME = "checkUpdate";
  const BADGE_TEXT = "UPD";
  const BADGE_COLOR = "#d93025";

  function isNewerVersion(latest, current) {
    const la = String(latest).split(".").map(function (p) { return parseInt(p, 10) || 0; });
    const ca = String(current).split(".").map(function (p) { return parseInt(p, 10) || 0; });
    const len = Math.max(la.length, ca.length);
    for (let i = 0; i < len; i++) {
      const l = la[i] || 0;
      const c = ca[i] || 0;
      if (l > c) return true;
      if (l < c) return false;
    }
    return false;
  }

  function notifyUpdate(data, latest) {
    chrome.storage.local.get("lastNotified").then(function (res) {
      if (res.lastNotified === latest) return;

      const updateInfo = {
        version: latest,
        url: data.url || "https://github.com/pcmhospital/bahmni_imis_chrome_extension/releases",
        zip_url: data.zip_url || "",
        changelog: data.changelog || ""
      };

      chrome.storage.local.set({ lastNotified: latest, updateInfo: updateInfo });

      chrome.action.setBadgeText({ text: BADGE_TEXT });
      chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });

      const message = (updateInfo.changelog || "A new version of IMIS Sync is available.").slice(0, 200);
      chrome.notifications.create("imis-update-" + latest, {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "v" + latest + " available",
        message: message,
        priority: 1
      });
    });
  }

  function checkForUpdate() {
    chrome.storage.local.get("githubToken", function (res) {
      const token = res.githubToken;
      if (!token) {
        console.log("[IMIS Sync] No GitHub token configured — skipping update check. Set one in extension Options.");
        return;
      }
      const url = VERSION_URL + "?t=" + Date.now();
      fetch(url, {
        cache: "no-store",
        headers: { "Authorization": "Bearer " + token, "Accept": "application/vnd.github.v3+json" }
      })
      .then(function (resp) {
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return resp.json();
      })
      .then(function (apiData) {
        // GitHub API returns file content as base64 — decode it
        const json = decodeURIComponent(escape(atob(apiData.content.replace(/\n/g, ""))));
        return JSON.parse(json);
      })
      .then(function (data) {
        const latest = String(data.version || "").trim();
        const current = chrome.runtime.getManifest().version;
        if (!latest || !isNewerVersion(latest, current)) return;
        notifyUpdate(data, latest);
      })
      .catch(function (err) {
        console.log("[IMIS Sync] Update check failed:", err && err.message ? err.message : err);
      });
    });
  }

  chrome.runtime.onInstalled.addListener(function () {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: CHECK_INTERVAL_MINUTES });
    checkForUpdate();
  });

  chrome.alarms.onAlarm.addListener(function (alarm) {
    if (alarm.name === ALARM_NAME) checkForUpdate();
  });

  chrome.notifications.onClicked.addListener(function (notificationId) {
    chrome.notifications.clear(notificationId);
    chrome.storage.local.get("updateInfo").then(function (res) {
      if (res.updateInfo && res.updateInfo.url) {
        chrome.tabs.create({ url: res.updateInfo.url });
      }
    });
  });
})();