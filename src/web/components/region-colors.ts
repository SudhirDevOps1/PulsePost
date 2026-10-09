/**
 * Region list, shared between the server's colo table and the map legend.
 *
 * Kept as a plain module so the map can import it without pulling in Leaflet,
 * which keeps the legend out of the initial chunk.
 */
export const REGIONS = [
  'Americas',
  'Europe',
  'Asia Pacific',
  'Middle East',
  'Africa',
] as const;

export type Region = (typeof REGIONS)[number];