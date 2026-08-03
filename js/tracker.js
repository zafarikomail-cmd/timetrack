/*
  TimeTracker snippet
  -------------------
  Drop this in your site (e.g. add <script src="/tracker.js"></script>
  before the closing </body> tag), and set BACKEND_URL below to your
  ngrok URL (see server/README.md).

  It silently does nothing if the backend is unreachable, so it will
  never break your site even if your laptop is off.
*/
(function () {
  // 👇 Your ngrok URL
  const BACKEND_URL = "https://stoke-acquaint-womankind.ngrok-free.dev";

  // One id per browser tab session
  function getSessionId() {
    let id = sessionStorage.getItem("tt_session_id");
    if (!id) {
      id = "s_" + Date.now() + "_" + Math.random().toString(36).slice(2);
      sessionStorage.setItem("tt_session_id", id);
    }
    return id;
  }

  const sessionId = getSessionId();

  function send(path, data) {
    const body = JSON.stringify({ session_id: sessionId, ...data });
    // Use sendBeacon when possible (works even as the tab is closing)
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: "application/json" });
      navigator.sendBeacon(BACKEND_URL + path, blob);
    } else {
      fetch(BACKEND_URL + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "ngrok-skip-browser-warning": "true",
        },
        body,
        keepalive: true,
      }).catch(() => {}); // fail silently if backend is offline
    }
  }

  // Register the visit on page load
  send("/api/visit", { referrer: document.referrer });

  // Heartbeat every 15s while the tab is open/visible
  const HEARTBEAT_MS = 15000;
  const interval = setInterval(() => {
    if (document.visibilityState === "visible") {
      send("/api/heartbeat", {});
    }
  }, HEARTBEAT_MS);

  // Final heartbeat when the tab is closed or navigated away
  window.addEventListener("pagehide", () => send("/api/heartbeat", {}));
  window.addEventListener("beforeunload", () => send("/api/heartbeat", {}));
})();
