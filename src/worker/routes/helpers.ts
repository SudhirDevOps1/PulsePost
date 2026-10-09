import type { RequestCf } from '../util/ip.ts';

export type RequestCfLike = RequestCf;

export { lookupColo, coloCoordinates, ALL_COLOS, REGIONS } from '../util/colo.ts';
export { nowIso } from '../db/dialect.ts';