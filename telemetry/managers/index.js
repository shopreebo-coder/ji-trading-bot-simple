"use strict";
/**
 * SHADOW OS v2 — Manager Tier
 * Barrel export for all implemented managers.
 *
 * Sprint 1: RuntimeDomainManager (✅ implemented)
 * Sprint 2: TradeIntentManager   (✅ implemented)
 * Sprint 3: MemoryManager        (✅ implemented)
 * Sprint 4: KnowledgeManager     (planned)
 * Sprint 5: RecoveryManager      (planned)
 * Sprint 5: ValidationManager    (planned)
 */

const { RuntimeDomainManager, DEFAULT_DOMAINS, REQUIRED_TABLES } = require("./RuntimeDomainManager");
const { TradeIntentManager, VALID_TRANSITIONS, VALID_INTENT_TYPES, VALID_DIRECTIONS } = require("./TradeIntentManager");
const { MemoryManager, VALID_STATUSES, VALID_CHANGE_OPS, MUTABLE_FIELDS, IMMUTABLE_FIELDS } = require("./MemoryManager");

module.exports = {
  RuntimeDomainManager,
  DEFAULT_DOMAINS,
  REQUIRED_TABLES,
  TradeIntentManager,
  VALID_TRANSITIONS,
  VALID_INTENT_TYPES,
  VALID_DIRECTIONS,
  MemoryManager,
  VALID_STATUSES,
  VALID_CHANGE_OPS,
  MUTABLE_FIELDS,
  IMMUTABLE_FIELDS,
};
