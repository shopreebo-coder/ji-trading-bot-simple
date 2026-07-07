"use strict";
/**
 * SHADOW OS v2 — Manager Tier
 * Barrel export for all implemented managers.
 *
 * Sprint 1: RuntimeDomainManager (✅ implemented)
 * Sprint 3: MemoryManager        (planned)
 * Sprint 4: KnowledgeManager     (planned)
 * Sprint 5: RecoveryManager      (planned)
 * Sprint 5: ValidationManager    (planned)
 */

const { RuntimeDomainManager, DEFAULT_DOMAINS, REQUIRED_TABLES } = require("./RuntimeDomainManager");

module.exports = {
  RuntimeDomainManager,
  DEFAULT_DOMAINS,
  REQUIRED_TABLES,
};
