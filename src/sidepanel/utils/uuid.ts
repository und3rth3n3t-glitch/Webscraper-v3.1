export function uuid(): string {
  return crypto.randomUUID();
}

export const generateId = uuid;
