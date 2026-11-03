import type { ProjectSnapshot } from './projectService';

/** The documents of one domain in a snapshot, in either of the shapes a snapshot holds them. */
export function nativeDomainRecords(snapshot: ProjectSnapshot | null, domain: string): Array<Record<string, any>> {
  const raw = snapshot?.domains?.[domain];
  const values = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { documents?: unknown[] }).documents)
      ? (raw as { documents: unknown[] }).documents : [];
  return values.filter((value): value is Record<string, any> => Boolean(value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string'));
}
