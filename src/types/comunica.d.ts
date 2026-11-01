// Type-check stand-ins for the linked Comunica packages, so tsc does not compile their .ts sources.
declare module '@comunica/query-sparql-rdfjs-lite' {
  import type * as RDF from '@rdfjs/types';

  type Stream<T> = RDF.ResultStream<T> & { destroy: (cause?: Error) => void };
  export type QueryResult =
    | { resultType: 'bindings'; execute: () => Promise<Stream<Iterable<[RDF.Variable, RDF.Term]>>> }
    | { resultType: 'quads'; execute: () => Promise<Stream<RDF.Quad>> }
    | { resultType: 'boolean'; execute: () => Promise<boolean> }
    | { resultType: 'void'; execute: () => Promise<void> };

  export class QueryEngine {
    public query(query: string, context: { sources: RDF.Store[] }): Promise<QueryResult>;
  }
}

declare module '@comunica/utils-iterator' {
  import type * as RDF from '@rdfjs/types';

  export function compareTerms(left: RDF.Term, right: RDF.Term): number;
}
