/**
 * Cloudflare colo reference data.
 *
 * Health checks report `request.cf.colo` (e.g. `LHR`, `NRT`, `SJC`). The edge
 * map needs coordinates to plot those, and Cloudflare's public list is a few
 * hundred entries that change rarely — so it is inlined here rather than
 * fetched at runtime.
 *
 * Coordinates are city centroids, accurate to a few kilometres. That is the
 * right precision for a map marker and avoids shipping a GeoJSON boundary set.
 */

export interface ColoInfo {
  colo: string;
  city: string;
  country: string;
  /** Coarse region used for grouping on the dashboard. */
  region: 'Americas' | 'Europe' | 'Asia Pacific' | 'Middle East' | 'Africa';
  lat: number;
  lon: number;
}

export const REGIONS: ColoInfo['region'][] = [
  'Americas',
  'Europe',
  'Asia Pacific',
  'Middle East',
  'Africa',
];

const AMERICAS: ColoInfo['region'] = 'Americas';
const EUROPE: ColoInfo['region'] = 'Europe';
const APAC: ColoInfo['region'] = 'Asia Pacific';
const ME: ColoInfo['region'] = 'Middle East';
const AFRICA: ColoInfo['region'] = 'Africa';

const COLOS: ColoInfo[] = [
  // --- Americas ---
  { colo: 'YYZ', city: 'Toronto', country: 'CA', region: AMERICAS, lat: 43.65, lon: -79.38 },
  { colo: 'YUL', city: 'Montreal', country: 'CA', region: AMERICAS, lat: 45.5, lon: -73.57 },
  { colo: 'YYC', city: 'Calgary', country: 'CA', region: AMERICAS, lat: 51.05, lon: -114.07 },
  { colo: 'YVR', city: 'Vancouver', country: 'CA', region: AMERICAS, lat: 49.2, lon: -123.18 },
  { colo: 'MEX', city: 'Mexico City', country: 'MX', region: AMERICAS, lat: 19.43, lon: -99.13 },
  { colo: 'QRO', city: 'Queretaro', country: 'MX', region: AMERICAS, lat: 20.59, lon: -100.39 },
  { colo: 'GRU', city: 'Sao Paulo', country: 'BR', region: AMERICAS, lat: -23.55, lon: -46.63 },
  { colo: 'GIG', city: 'Rio de Janeiro', country: 'BR', region: AMERICAS, lat: -22.81, lon: -43.25 },
  { colo: 'EZE', city: 'Buenos Aires', country: 'AR', region: AMERICAS, lat: -34.6, lon: -58.38 },
  { colo: 'SCL', city: 'Santiago', country: 'CL', region: AMERICAS, lat: -33.45, lon: -70.67 },
  { colo: 'LIM', city: 'Lima', country: 'PE', region: AMERICAS, lat: -12.05, lon: -77.04 },
  { colo: 'BOG', city: 'Bogota', country: 'CO', region: AMERICAS, lat: 4.71, lon: -74.07 },
  { colo: 'MIA', city: 'Miami', country: 'US', region: AMERICAS, lat: 25.76, lon: -80.19 },
  { colo: 'ATL', city: 'Atlanta', country: 'US', region: AMERICAS, lat: 33.75, lon: -84.39 },
  { colo: 'IAD', city: 'Ashburn', country: 'US', region: AMERICAS, lat: 39.04, lon: -77.49 },
  { colo: 'EWR', city: 'Newark', country: 'US', region: AMERICAS, lat: 40.74, lon: -74.17 },
  { colo: 'BOS', city: 'Boston', country: 'US', region: AMERICAS, lat: 42.36, lon: -71.06 },
  { colo: 'PHL', city: 'Philadelphia', country: 'US', region: AMERICAS, lat: 39.95, lon: -75.17 },
  { colo: 'ORD', city: 'Chicago', country: 'US', region: AMERICAS, lat: 41.88, lon: -87.63 },
  { colo: 'DFW', city: 'Dallas', country: 'US', region: AMERICAS, lat: 32.78, lon: -96.8 },
  { colo: 'DEN', city: 'Denver', country: 'US', region: AMERICAS, lat: 39.74, lon: -104.99 },
  { colo: 'MSP', city: 'Minneapolis', country: 'US', region: AMERICAS, lat: 44.98, lon: -93.27 },
  { colo: 'DTW', city: 'Detroit', country: 'US', region: AMERICAS, lat: 42.33, lon: -83.05 },
  { colo: 'SLC', city: 'Salt Lake City', country: 'US', region: AMERICAS, lat: 40.76, lon: -111.89 },
  { colo: 'LAX', city: 'Los Angeles', country: 'US', region: AMERICAS, lat: 34.05, lon: -118.24 },
  { colo: 'SJC', city: 'San Jose', country: 'US', region: AMERICAS, lat: 37.34, lon: -121.89 },
  { colo: 'SFO', city: 'San Francisco', country: 'US', region: AMERICAS, lat: 37.77, lon: -122.42 },
  { colo: 'SEA', city: 'Seattle', country: 'US', region: AMERICAS, lat: 47.61, lon: -122.33 },
  { colo: 'PDX', city: 'Portland', country: 'US', region: AMERICAS, lat: 45.52, lon: -122.68 },
  { colo: 'ANC', city: 'Anchorage', country: 'US', region: AMERICAS, lat: 61.22, lon: -149.9 },
  { colo: 'HNL', city: 'Honolulu', country: 'US', region: AMERICAS, lat: 21.31, lon: -157.86 },
  { colo: 'KEF', city: 'Reykjavik', country: 'IS', region: EUROPE, lat: 63.99, lon: -22.61 },

  // --- Europe ---
  { colo: 'LHR', city: 'London', country: 'GB', region: EUROPE, lat: 51.51, lon: -0.13 },
  { colo: 'MAN', city: 'Manchester', country: 'GB', region: EUROPE, lat: 53.48, lon: -2.24 },
  { colo: 'DUB', city: 'Dublin', country: 'IE', region: EUROPE, lat: 53.35, lon: -6.26 },
  { colo: 'CDG', city: 'Paris', country: 'FR', region: EUROPE, lat: 48.86, lon: 2.35 },
  { colo: 'MRS', city: 'Marseille', country: 'FR', region: EUROPE, lat: 43.3, lon: 5.37 },
  { colo: 'AMS', city: 'Amsterdam', country: 'NL', region: EUROPE, lat: 52.37, lon: 4.9 },
  { colo: 'BRU', city: 'Brussels', country: 'BE', region: EUROPE, lat: 50.85, lon: 4.35 },
  { colo: 'FRA', city: 'Frankfurt', country: 'DE', region: EUROPE, lat: 50.11, lon: 8.68 },
  { colo: 'DUS', city: 'Dusseldorf', country: 'DE', region: EUROPE, lat: 51.23, lon: 6.78 },
  { colo: 'BER', city: 'Berlin', country: 'DE', region: EUROPE, lat: 52.52, lon: 13.4 },
  { colo: 'HAM', city: 'Hamburg', country: 'DE', region: EUROPE, lat: 53.55, lon: 9.99 },
  { colo: 'MUC', city: 'Munich', country: 'DE', region: EUROPE, lat: 48.14, lon: 11.58 },
  { colo: 'ZRH', city: 'Zurich', country: 'CH', region: EUROPE, lat: 47.38, lon: 8.54 },
  { colo: 'GVA', city: 'Geneva', country: 'CH', region: EUROPE, lat: 46.2, lon: 6.14 },
  { colo: 'VIE', city: 'Vienna', country: 'AT', region: EUROPE, lat: 48.21, lon: 16.37 },
  { colo: 'MIL', city: 'Milan', country: 'IT', region: EUROPE, lat: 45.46, lon: 9.19 },
  { colo: 'FCO', city: 'Rome', country: 'IT', region: EUROPE, lat: 41.9, lon: 12.5 },
  { colo: 'MAD', city: 'Madrid', country: 'ES', region: EUROPE, lat: 40.42, lon: -3.7 },
  { colo: 'BCN', city: 'Barcelona', country: 'ES', region: EUROPE, lat: 41.39, lon: 2.17 },
  { colo: 'LIS', city: 'Lisbon', country: 'PT', region: EUROPE, lat: 38.72, lon: -9.14 },
  { colo: 'CPH', city: 'Copenhagen', country: 'DK', region: EUROPE, lat: 55.68, lon: 12.57 },
  { colo: 'ARN', city: 'Stockholm', country: 'SE', region: EUROPE, lat: 59.33, lon: 18.07 },
  { colo: 'OSL', city: 'Oslo', country: 'NO', region: EUROPE, lat: 59.91, lon: 10.75 },
  { colo: 'HEL', city: 'Helsinki', country: 'FI', region: EUROPE, lat: 60.17, lon: 24.94 },
  { colo: 'WAW', city: 'Warsaw', country: 'PL', region: EUROPE, lat: 52.23, lon: 21.01 },
  { colo: 'PRG', city: 'Prague', country: 'CZ', region: EUROPE, lat: 50.08, lon: 14.44 },
  { colo: 'BUD', city: 'Budapest', country: 'HU', region: EUROPE, lat: 47.5, lon: 19.04 },
  { colo: 'OTP', city: 'Bucharest', country: 'RO', region: EUROPE, lat: 44.43, lon: 26.1 },
  { colo: 'SOF', city: 'Sofia', country: 'BG', region: EUROPE, lat: 42.7, lon: 23.32 },
  { colo: 'ATH', city: 'Athens', country: 'GR', region: EUROPE, lat: 37.98, lon: 23.73 },
  { colo: 'IST', city: 'Istanbul', country: 'TR', region: EUROPE, lat: 41.01, lon: 28.98 },
  { colo: 'KBP', city: 'Kyiv', country: 'UA', region: EUROPE, lat: 50.45, lon: 30.52 },
  { colo: 'RIX', city: 'Riga', country: 'LV', region: EUROPE, lat: 56.95, lon: 24.11 },
  { colo: 'VNO', city: 'Vilnius', country: 'LT', region: EUROPE, lat: 54.69, lon: 25.28 },
  { colo: 'TLL', city: 'Tallinn', country: 'EE', region: EUROPE, lat: 59.44, lon: 24.75 },

  // --- Asia Pacific ---
  { colo: 'NRT', city: 'Tokyo', country: 'JP', region: APAC, lat: 35.68, lon: 139.69 },
  { colo: 'KIX', city: 'Osaka', country: 'JP', region: APAC, lat: 34.69, lon: 135.5 },
  { colo: 'FUK', city: 'Fukuoka', country: 'JP', region: APAC, lat: 33.59, lon: 130.4 },
  { colo: 'CTS', city: 'Sapporo', country: 'JP', region: APAC, lat: 43.06, lon: 141.35 },
  { colo: 'ICN', city: 'Seoul', country: 'KR', region: APAC, lat: 37.57, lon: 126.98 },
  { colo: 'HKG', city: 'Hong Kong', country: 'HK', region: APAC, lat: 22.32, lon: 114.17 },
  { colo: 'TPE', city: 'Taipei', country: 'TW', region: APAC, lat: 25.03, lon: 121.57 },
  { colo: 'SIN', city: 'Singapore', country: 'SG', region: APAC, lat: 1.35, lon: 103.82 },
  { colo: 'KUL', city: 'Kuala Lumpur', country: 'MY', region: APAC, lat: 3.14, lon: 101.69 },
  { colo: 'BKK', city: 'Bangkok', country: 'TH', region: APAC, lat: 13.76, lon: 100.5 },
  { colo: 'CGK', city: 'Jakarta', country: 'ID', region: APAC, lat: -6.21, lon: 106.85 },
  { colo: 'MNL', city: 'Manila', country: 'PH', region: APAC, lat: 14.6, lon: 120.98 },
  { colo: 'SGN', city: 'Ho Chi Minh City', country: 'VN', region: APAC, lat: 10.82, lon: 106.63 },
  { colo: 'HAN', city: 'Hanoi', country: 'VN', region: APAC, lat: 21.03, lon: 105.85 },
  { colo: 'DAD', city: 'Da Nang', country: 'VN', region: APAC, lat: 16.05, lon: 108.2 },
  { colo: 'PNH', city: 'Phnom Penh', country: 'KH', region: APAC, lat: 11.56, lon: 104.93 },
  { colo: 'DEL', city: 'New Delhi', country: 'IN', region: APAC, lat: 28.61, lon: 77.21 },
  { colo: 'BOM', city: 'Mumbai', country: 'IN', region: APAC, lat: 19.08, lon: 72.88 },
  { colo: 'BLR', city: 'Bangalore', country: 'IN', region: APAC, lat: 12.97, lon: 77.59 },
  { colo: 'MAA', city: 'Chennai', country: 'IN', region: APAC, lat: 13.08, lon: 80.27 },
  { colo: 'HYD', city: 'Hyderabad', country: 'IN', region: APAC, lat: 17.39, lon: 78.49 },
  { colo: 'CCU', city: 'Kolkata', country: 'IN', region: APAC, lat: 22.57, lon: 88.36 },
  { colo: 'AMD', city: 'Ahmedabad', country: 'IN', region: APAC, lat: 23.02, lon: 72.57 },
  { colo: 'CMB', city: 'Colombo', country: 'LK', region: APAC, lat: 6.93, lon: 79.86 },
  { colo: 'KTM', city: 'Kathmandu', country: 'NP', region: APAC, lat: 27.72, lon: 85.32 },
  { colo: 'DAC', city: 'Dhaka', country: 'BD', region: APAC, lat: 23.81, lon: 90.41 },
  { colo: 'KHH', city: 'Kaohsiung', country: 'TW', region: APAC, lat: 22.63, lon: 120.3 },
  { colo: 'PNQ', city: 'Pune', country: 'IN', region: APAC, lat: 18.52, lon: 73.86 },
  { colo: 'SYD', city: 'Sydney', country: 'AU', region: APAC, lat: -33.87, lon: 151.21 },
  { colo: 'MEL', city: 'Melbourne', country: 'AU', region: APAC, lat: -37.81, lon: 144.96 },
  { colo: 'BRQ', city: 'Brisbane', country: 'AU', region: APAC, lat: -27.47, lon: 153.03 },
  { colo: 'PER', city: 'Perth', country: 'AU', region: APAC, lat: -31.95, lon: 115.86 },
  { colo: 'ADL', city: 'Adelaide', country: 'AU', region: APAC, lat: -34.93, lon: 138.6 },
  { colo: 'CNS', city: 'Cairns', country: 'AU', region: APAC, lat: -16.92, lon: 145.77 },
  { colo: 'AKL', city: 'Auckland', country: 'NZ', region: APAC, lat: -36.85, lon: 174.76 },
  { colo: 'CHC', city: 'Christchurch', country: 'NZ', region: APAC, lat: -43.53, lon: 172.64 },
  { colo: 'GUM', city: 'Hagatna', country: 'GU', region: APAC, lat: 13.47, lon: 144.75 },

  // --- Middle East / Central Asia ---
  { colo: 'DXB', city: 'Dubai', country: 'AE', region: ME, lat: 25.2, lon: 55.27 },
  { colo: 'AUH', city: 'Abu Dhabi', country: 'AE', region: ME, lat: 24.45, lon: 54.38 },
  { colo: 'DOH', city: 'Doha', country: 'QA', region: ME, lat: 25.29, lon: 51.53 },
  { colo: 'KWI', city: 'Kuwait City', country: 'KW', region: ME, lat: 29.38, lon: 47.99 },
  { colo: 'BAH', city: 'Manama', country: 'BH', region: ME, lat: 26.23, lon: 50.59 },
  { colo: 'MCT', city: 'Muscat', country: 'OM', region: ME, lat: 23.59, lon: 58.41 },
  { colo: 'TLV', city: 'Tel Aviv', country: 'IL', region: ME, lat: 32.09, lon: 34.78 },
  { colo: 'AMM', city: 'Amman', country: 'JO', region: ME, lat: 31.95, lon: 35.93 },
  { colo: 'BEY', city: 'Beirut', country: 'LB', region: ME, lat: 33.89, lon: 35.5 },
  { colo: 'BGW', city: 'Baghdad', country: 'IQ', region: ME, lat: 33.31, lon: 44.37 },
  { colo: 'KHI', city: 'Karachi', country: 'PK', region: ME, lat: 24.86, lon: 67.01 },
  { colo: 'ISB', city: 'Islamabad', country: 'PK', region: ME, lat: 33.68, lon: 73.05 },
  { colo: 'LHE', city: 'Lahore', country: 'PK', region: ME, lat: 31.55, lon: 74.34 },
  { colo: 'TAS', city: 'Tashkent', country: 'UZ', region: ME, lat: 41.3, lon: 69.24 },
  { colo: 'ALA', city: 'Almaty', country: 'KZ', region: ME, lat: 43.24, lon: 76.89 },

  // --- Africa ---
  { colo: 'JNB', city: 'Johannesburg', country: 'ZA', region: AFRICA, lat: -26.2, lon: 28.05 },
  { colo: 'CPT', city: 'Cape Town', country: 'ZA', region: AFRICA, lat: -33.92, lon: 18.42 },
  { colo: 'DUR', city: 'Durban', country: 'ZA', region: AFRICA, lat: -29.86, lon: 31.02 },
  { colo: 'NBO', city: 'Nairobi', country: 'KE', region: AFRICA, lat: -1.29, lon: 36.82 },
  { colo: 'LOS', city: 'Lagos', country: 'NG', region: AFRICA, lat: 6.52, lon: 3.38 },
  { colo: 'ABV', city: 'Abuja', country: 'NG', region: AFRICA, lat: 9.06, lon: 7.5 },
  { colo: 'ACC', city: 'Accra', country: 'GH', region: AFRICA, lat: 5.6, lon: -0.19 },
  { colo: 'DKR', city: 'Dakar', country: 'SN', region: AFRICA, lat: 14.72, lon: -17.47 },
  { colo: 'CMN', city: 'Casablanca', country: 'MA', region: AFRICA, lat: 33.57, lon: -7.59 },
  { colo: 'TUN', city: 'Tunis', country: 'TN', region: AFRICA, lat: 36.81, lon: 10.18 },
  { colo: 'ALG', city: 'Algiers', country: 'DZ', region: AFRICA, lat: 36.75, lon: 3.06 },
  { colo: 'CAI', city: 'Cairo', country: 'EG', region: AFRICA, lat: 30.04, lon: 31.24 },
  { colo: 'DAR', city: 'Dar es Salaam', country: 'TZ', region: AFRICA, lat: -6.79, lon: 39.21 },
  { colo: 'KGL', city: 'Kigali', country: 'RW', region: AFRICA, lat: -1.94, lon: 30.06 },
  { colo: 'LAD', city: 'Luanda', country: 'AO', region: AFRICA, lat: -8.84, lon: 13.23 },
  { colo: 'MRU', city: 'Port Louis', country: 'MU', region: AFRICA, lat: -20.16, lon: 57.5 },
];

const BY_COLO = new Map<string, ColoInfo>();
for (const entry of COLOS) {
  // First definition wins, so duplicate codes cannot shadow each other.
  if (!BY_COLO.has(entry.colo)) BY_COLO.set(entry.colo, entry);
}

export const ALL_COLOS: readonly ColoInfo[] = COLOS;

export function lookupColo(code: string | undefined | null): ColoInfo | null {
  if (!code) return null;
  return BY_COLO.get(code.toUpperCase()) ?? null;
}

/** Coordinates for a colo, falling back to null rather than guessing. */
export function coloCoordinates(code: string): { lat: number; lon: number } | null {
  const info = lookupColo(code);
  return info ? { lat: info.lat, lon: info.lon } : null;
}