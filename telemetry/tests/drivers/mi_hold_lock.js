"use strict";
/**
 * Sprint 4 test driver — acquires the LiveMemoryIntegration advisory lock and
 * holds it until killed. Used by the stress suite to simulate a second live
 * process (duplicate startup / concurrent recovery scenarios).
 *
 * Prints exactly one line to stdout:
 *   LOCKED    — this process owns the recovery lock
 *   NOLOCK    — another process owns it
 * Then holds until SIGTERM/SIGKILL.
 */
const { LiveMemoryIntegration } = require("../../managers");

(async () => {
  const lmi = new LiveMemoryIntegration({ calledBy: "mi_driver_hold" });
  const ini = await lmi.init();
  if (!ini.ok) { console.log("INITFAIL " + ini.error); process.exit(2); }
  const lock = await lmi._acquireLock();
  console.log(lock.acquired ? "LOCKED" : "NOLOCK");
  // Hold forever — the test kills us. Keep the event loop alive.
  setInterval(() => {}, 60000);
})().catch(err => { console.log("FATAL " + err.message); process.exit(1); });
