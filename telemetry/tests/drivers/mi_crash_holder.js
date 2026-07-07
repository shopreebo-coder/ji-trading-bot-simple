"use strict";
/**
 * Sprint 4 test driver — simulates a live process that dies without ANY
 * cleanup (power loss / SIGKILL). Acquires the recovery lock, starts a burst
 * of memory writes, prints "READY", then spins until SIGKILL'd by the test.
 *
 * The test verifies that after SIGKILL:
 *   1. Postgres frees the session-scoped advisory lock (next boot can recover)
 *   2. Partially-flushed writes are safe (dedupe keys make retries idempotent)
 */
const { LiveMemoryIntegration } = require("../../managers");

(async () => {
  const lmi = new LiveMemoryIntegration({ calledBy: "mi_driver_crash" });
  const ini = await lmi.init();
  if (!ini.ok) { console.log("INITFAIL " + ini.error); process.exit(2); }
  // Retry briefly — a previous test's killed lock-holder may take a moment
  // for Postgres to reap. This driver must END UP holding the lock.
  let acquired = false;
  for (let i = 0; i < 20 && !acquired; i++) {
    const lock = await lmi._acquireLock();
    acquired = lock.acquired;
    if (!acquired) await new Promise(r => setTimeout(r, 500));
  }
  if (!acquired) { console.log("NOLOCK"); process.exit(3); }
  // Fire a burst of writes and DO NOT await them all — power loss mid-flight.
  for (let i = 0; i < 25; i++) {
    lmi.recordTradeOpen({ symbol: `MI_CRASH_${i}`, side: "BUY" });
  }
  console.log("READY");
  setInterval(() => {}, 60000); // spin until SIGKILL
})().catch(err => { console.log("FATAL " + err.message); process.exit(1); });
