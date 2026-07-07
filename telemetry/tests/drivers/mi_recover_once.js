"use strict";
/**
 * Sprint 4 test driver — runs one full startup recovery then a graceful
 * shutdown, printing the JSON report. Used for concurrent-recovery races
 * (two of these spawned simultaneously → exactly one must acquire the lock).
 *
 * argv[2] (optional): hold ms before shutdown (default 0).
 */
const { LiveMemoryIntegration } = require("../../managers");

(async () => {
  const holdMs = parseInt(process.argv[2] || "0", 10);
  const lmi = new LiveMemoryIntegration({ calledBy: "mi_driver_recover" });
  const ini = await lmi.init();
  if (!ini.ok) { console.log("RESULT " + JSON.stringify({ fatal: "init: " + ini.error })); process.exit(2); }
  const rep = await lmi.recoverOnStartup({ liveState: { dailyTrades: 0, openTrades: {} } });
  // "RESULT " prefix — the module writes its own console lines, so the test
  // must be able to find this line among them.
  console.log("RESULT " + JSON.stringify({
    recovered: rep.recovered, reason: rep.reason, lockAcquired: rep.lockAcquired,
    snapshotId: rep.snapshotId, durationMs: rep.durationMs, bootId: rep.bootId,
  }));
  if (holdMs > 0) await new Promise(r => setTimeout(r, holdMs));
  await lmi.gracefulShutdown({ reason: "driver-exit" });
  process.exit(0);
})().catch(err => { console.log("RESULT " + JSON.stringify({ fatal: err.message })); process.exit(1); });
