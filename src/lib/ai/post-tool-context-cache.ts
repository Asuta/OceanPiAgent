export interface PostToolCompactedContextState<TMessage> {
  rawMessageCount: number;
  rawMessageSignatures: string[];
  effectiveMessages: TMessage[];
}

export function createPostToolCompactedContextState<TMessage>(args: {
  rawMessages: TMessage[];
  effectiveMessages: TMessage[];
  rawMessageSignatures: string[];
}): PostToolCompactedContextState<TMessage> | null {
  if (args.rawMessageSignatures.length === 0) {
    return null;
  }

  return {
    rawMessageCount: args.rawMessages.length,
    rawMessageSignatures: args.rawMessageSignatures,
    effectiveMessages: args.effectiveMessages,
  };
}

export function applyPostToolCompactedContextState<TMessage>(args: {
  messages: TMessage[];
  state: PostToolCompactedContextState<TMessage> | null;
  rawMessageSignatures: string[];
}): {
  effectiveMessages: TMessage[];
  rawMessageSignatures: string[];
  cacheApplied: boolean;
} {
  if (!args.state || args.rawMessageSignatures.length === 0) {
    return {
      effectiveMessages: args.messages,
      rawMessageSignatures: args.rawMessageSignatures,
      cacheApplied: false,
    };
  }

  if (
    args.state.rawMessageCount > args.messages.length
    || !startsWithHistoryMessageSignatures(args.rawMessageSignatures, args.state.rawMessageSignatures)
  ) {
    return {
      effectiveMessages: args.messages,
      rawMessageSignatures: args.rawMessageSignatures,
      cacheApplied: false,
    };
  }

  return {
    effectiveMessages: [
      ...args.state.effectiveMessages,
      ...args.messages.slice(args.state.rawMessageCount),
    ],
    rawMessageSignatures: args.rawMessageSignatures,
    cacheApplied: true,
  };
}

function startsWithHistoryMessageSignatures(candidate: string[], prefix: string[]): boolean {
  if (prefix.length > candidate.length) {
    return false;
  }

  for (let index = 0; index < prefix.length; index += 1) {
    if (candidate[index] !== prefix[index]) {
      return false;
    }
  }

  return true;
}
