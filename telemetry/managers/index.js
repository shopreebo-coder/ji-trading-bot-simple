"use strict";
/**
 * SHADOW OS v2 — Manager Tier
 * Barrel export for all implemented managers.
 *
 * Sprint 1: RuntimeDomainManager   (✅ implemented)
 * Sprint 2: TradeIntentManager     (✅ implemented)
 * Sprint 3: MemoryManager          (✅ implemented)
 * Sprint 4: LiveMemoryIntegration  (✅ implemented — live-engine integration layer)
 * Sprint 5: ShadowLabManager       (✅ implemented — research-only measurement layer)
 * Sprint 6: KnowledgeManager       (planned)
 * Sprint 6: RecoveryManager        (planned)
 * Sprint 6: ValidationManager      (planned)
 */

const { RuntimeDomainManager, DEFAULT_DOMAINS, REQUIRED_TABLES } = require("./RuntimeDomainManager");
const { TradeIntentManager, VALID_TRANSITIONS, VALID_INTENT_TYPES, VALID_DIRECTIONS } = require("./TradeIntentManager");
const { MemoryManager, VALID_STATUSES, VALID_CHANGE_OPS, MUTABLE_FIELDS, IMMUTABLE_FIELDS } = require("./MemoryManager");
const { LiveMemoryIntegration, LOCK_CLASS, LOCK_OBJ, OPEN_INTENT_STATUSES, SNAPSHOT_WALKBACK_LIMIT } = require("./LiveMemoryIntegration");
const { ShadowLabManager, SOURCE_EVENT_TYPES, ENGINE_BY_TYPE, CURSOR_TYPE } = require("./ShadowLabManager");
const { createProvenance, confidenceLevel, configHash, CONFIDENCE_THRESHOLDS, SYSTEM_VERSION } = require("./shadowLabProvenance");

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
  LiveMemoryIntegration,
  LOCK_CLASS,
  LOCK_OBJ,
  OPEN_INTENT_STATUSES,
  SNAPSHOT_WALKBACK_LIMIT,
  // Sprint 5 — Shadow LAB research layer
  ShadowLabManager,
  SOURCE_EVENT_TYPES,
  ENGINE_BY_TYPE,
  CURSOR_TYPE,
  createProvenance,
  confidenceLevel,
  configHash,
  CONFIDENCE_THRESHOLDS,
  SYSTEM_VERSION,
};
