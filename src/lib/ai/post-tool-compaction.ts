export function shouldApplyPostToolBatchCompaction(args: {
  pendingPostToolBatchCompaction: boolean;
  hasPostToolBatchCompactionHandler: boolean;
  finalRoomDeliveryShortCircuitArmed: boolean;
}): boolean {
  return args.pendingPostToolBatchCompaction
    && args.hasPostToolBatchCompactionHandler
    && !args.finalRoomDeliveryShortCircuitArmed;
}
