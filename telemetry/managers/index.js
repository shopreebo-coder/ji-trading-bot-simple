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
 * Sprint 6: KnowledgeManager       (✅ implemented — read-only knowledge layer)
 * Sprint 7: RecoveryManager        (planned)
 * Sprint 7: ValidationManager      (planned)
 */

const { RuntimeDomainManager, DEFAULT_DOMAINS, REQUIRED_TABLES } = require("./RuntimeDomainManager");
const { TradeIntentManager, VALID_TRANSITIONS, VALID_INTENT_TYPES, VALID_DIRECTIONS } = require("./TradeIntentManager");
const { MemoryManager, VALID_STATUSES, VALID_CHANGE_OPS, MUTABLE_FIELDS, IMMUTABLE_FIELDS } = require("./MemoryManager");
const { LiveMemoryIntegration, LOCK_CLASS, LOCK_OBJ, OPEN_INTENT_STATUSES, SNAPSHOT_WALKBACK_LIMIT } = require("./LiveMemoryIntegration");
const { ShadowLabManager, SOURCE_EVENT_TYPES, ENGINE_BY_TYPE, CURSOR_TYPE } = require("./ShadowLabManager");
const { createProvenance, confidenceLevel, configHash, CONFIDENCE_THRESHOLDS, SYSTEM_VERSION } = require("./shadowLabProvenance");
const { KnowledgeManager, KnowledgeRepository, ARTIFACTS: KNOWLEDGE_ARTIFACTS } = require("./KnowledgeManager");
const { SelectedEngineManager } = require("./SelectedEngineManager");
const { SelectedAdvisor, DEFAULT_ATTEMPT_DELAYS_MS, DEFAULT_STALE_MS, DEFAULT_RING_SIZE } = require("./SelectedAdvisor");

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
  // Sprint 6 — Knowledge layer (read-only)
  KnowledgeManager,
  KnowledgeRepository,
  KNOWLEDGE_ARTIFACTS,
  // Selected Engine — read-only intelligence orchestration
  SelectedEngineManager,
  // Selected Advisor — advisor-only bridge (live telemetry → Selected Engine opinion)
  SelectedAdvisor,
  DEFAULT_ATTEMPT_DELAYS_MS,
  DEFAULT_STALE_MS,
  DEFAULT_RING_SIZE,
};
