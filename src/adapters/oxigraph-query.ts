// Result consumption for Oxigraph, shared by the browser adapter and the Node reference run.
import type { QueryResult, TermLike } from './types';
import { touchTerm } from './types';

export interface OxigraphQuadLike {
  subject: TermLike;
  predicate: TermLike;
  object: TermLike;
  graph: TermLike;
}

export interface OxigraphStoreLike {
  query: (query: string) => boolean | Map<string, TermLike>[] | OxigraphQuadLike[] | string;
}

/** Store.query() is synchronous and returns fully built arrays; every term is still read once. */
export function runOxigraphQuery(store: OxigraphStoreLike, sparql: string): QueryResult {
  const result = store.query(sparql);
  if (typeof result === 'boolean') {
    return { count: result ? 1 : 0, checksum: 0, resultType: 'boolean' };
  }
  if (!Array.isArray(result)) {
    throw new TypeError(`Unexpected Oxigraph result of type ${typeof result}`);
  }
  let checksum = 0;
  let quads = false;
  for (const item of result) {
    if (item instanceof Map) {
      for (const term of item.values()) {
        checksum += touchTerm(term);
      }
    } else {
      quads = true;
      checksum += touchTerm(item.subject) + touchTerm(item.predicate) + touchTerm(item.object) +
        touchTerm(item.graph);
    }
  }
  return { count: result.length, checksum, resultType: quads ? 'quads' : 'bindings' };
}

