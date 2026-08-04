/* IMIS Sync — auto-reload when files change on network share.
   Extension lives at \\192.168.1.32\IMIS-App.
   When you copy new files to the share, version.json changes
   and this script detects it and reloads the extension. */
(function () {
  "use strict";

  var CHECK_MINUTES = 2;
  var ALARM = "shareCheck";

  function isNewer(a, b) {
    var pa = String(a).split(".").map(function (p) { return parseInt(p, 10) || 0; });
    var pb = String(b).split(".").map(function (p) { return parseInt(p, 10) || 0; });
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var x = pa[i] || 0, y = pb[i] || 0;
      if (x > y) return true;
      if (x < y) return false;
    }
    return false;
  }

  function check() {
    var current = chrome.runtime.getManifest().version;
    var url = chrome.runtime.getURL("version.json") + "?t=" + Date.now();

    fetch(url, { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var v = String(d.version || "").trim();
        if (v && isNewer(v, current)) {
          console.log("[IMIS Sync] New version on share: " + v + " (was " + current + "). Reloading...");
          setTimeout(function () { chrome.runtime.reload(); }, 300);
        }
      })
      .catch(function () {});
  }

  chrome.runtime.onInstalled.addListener(function () {
    chrome.alarms.create(ALARM, { periodInMinutes: CHECK_MINUTES });
    check();
  });

  chrome.alarms.onAlarm.addListener(function (a) {
    if (a.name === ALARM) check();
  });
})();
