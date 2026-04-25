import { useEffect } from 'react';
import { onContentMessage } from './messaging';

type MessageCallback = (payload: unknown, fullMessage: unknown) => void;

const handlers = new Map<string, Set<MessageCallback>>();
let started = false;

export function onMessage(type: string, callback: MessageCallback): () => void {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type)!.add(callback);
  return () => {
    const set = handlers.get(type);
    if (set) {
      set.delete(callback);
      if (set.size === 0) handlers.delete(type);
    }
  };
}

export function useContentMessage(
  type: string,
  callback: MessageCallback,
  deps: unknown[] = [],
): void {
  useEffect(() => {
    return onMessage(type, callback);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, ...deps]);
}

export function startDispatcher(): void {
  if (started) return;
  started = true;
  onContentMessage((message: Record<string, unknown>) => {
    const cbs = handlers.get(message.type as string);
    if (cbs) {
      for (const cb of cbs) {
        try {
          cb(message.payload, message);
        } catch (err) {
          console.error(`[messageDispatcher] Error in handler for ${message.type}:`, err);
        }
      }
    }
  });
}
