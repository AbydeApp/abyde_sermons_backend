export interface LibraryFacets {
  speakers: string[];
  series: string[];
  scriptures: string[];
  themes: string[];
  years: string[];
  tags: string[];
}

export const LIBRARY_FACETS = Symbol('LIBRARY_FACETS');

export interface LibraryFacetsPort {
  /** Distinct filter values across the church's READY sermons. */
  facets(churchId: string): Promise<LibraryFacets>;
}
