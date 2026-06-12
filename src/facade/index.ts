/**
 * facade/index.ts — Facade bridge module entry point
 *
 * Exports all bridge handlers and the sunset-checker.
 */

export { bridgeCall, resolvePort, isTargetAlive, BRIDGE_TARGETS, type ProxyResult, type BridgeTarget } from './facade.js';
export { bridgeListPorts, bridgeAllocatePort, bridgeReleasePort, bridgePortHeartbeat, bridgeReservePort, bridgeReleaseReserve, bridgeListReserved } from './ports-bridge.js';
export {
  bridgeListServices, bridgeGetService, bridgeStartService, bridgeStopService,
  bridgeRestartService, bridgeRegisterService, bridgeRegisterAndStart,
  bridgePortConflicts, bridgeServiceEvents, bridgeServiceAlerts,
  bridgeAdoptProcess, bridgeDeleteProcess, bridgeListProcesses,
  bridgeCreateTask, bridgeForwardTask, bridgeListTasks,
  bridgeSchedulerReservations, bridgeSchedulerCheckAdmission,
} from './process-bridge.js';
export {
  bridgePeerHeartbeat, bridgePeerNotify, bridgePeerNotifyPush,
  bridgePeerStatus, bridgePeerResolve,
} from './peer-sync-bridge.js';
export { bridgeLobsterPost, bridgeLobsterGet } from './inbox-bridge.js';
export {
  bridgeCheckupEvent,
  bridgeKnowLeverStatus, bridgeKnowLeverTopics, bridgeKnowLeverTopicDetail,
  bridgeKnowLeverRun, bridgeKnowLeverCancel, bridgeKnowLeverProgress,
  bridgeKnowLeverConfigGet, bridgeKnowLeverConfigPost, bridgeKnowLeverUsers,
  bridgeDigistStatus, bridgeDigistListInterests, bridgeDigistCreateInterest,
  bridgeDigistUpdateInterest, bridgeDigistDeleteInterest,
  bridgeDigistListSources, bridgeDigistAddSource, bridgeDigistRemoveSource,
  bridgeDigistCrawlTrigger, bridgeDigistCrawlHistory, bridgeDigistSyncToKnowLever,
} from './ops-bridge.js';
export { runSunsetCheck, getSunsetState, checkManualAccelerate, type SunsetState } from './sunset-checker.js';
