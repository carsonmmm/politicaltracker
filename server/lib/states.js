// Structural facts about the 2026 ballot. These are not live numbers; they
// describe which seats exist. Each list cites where it can be checked.

export const STATES = [
  // [postal, name, fips, house seats (2020 apportionment)]
  ['AL', 'Alabama', '01', 7], ['AK', 'Alaska', '02', 1], ['AZ', 'Arizona', '04', 9],
  ['AR', 'Arkansas', '05', 4], ['CA', 'California', '06', 52], ['CO', 'Colorado', '08', 8],
  ['CT', 'Connecticut', '09', 5], ['DE', 'Delaware', '10', 1], ['FL', 'Florida', '12', 28],
  ['GA', 'Georgia', '13', 14], ['HI', 'Hawaii', '15', 2], ['ID', 'Idaho', '16', 2],
  ['IL', 'Illinois', '17', 17], ['IN', 'Indiana', '18', 9], ['IA', 'Iowa', '19', 4],
  ['KS', 'Kansas', '20', 4], ['KY', 'Kentucky', '21', 6], ['LA', 'Louisiana', '22', 6],
  ['ME', 'Maine', '23', 2], ['MD', 'Maryland', '24', 8], ['MA', 'Massachusetts', '25', 9],
  ['MI', 'Michigan', '26', 13], ['MN', 'Minnesota', '27', 8], ['MS', 'Mississippi', '28', 4],
  ['MO', 'Missouri', '29', 8], ['MT', 'Montana', '30', 2], ['NE', 'Nebraska', '31', 3],
  ['NV', 'Nevada', '32', 4], ['NH', 'New Hampshire', '33', 2], ['NJ', 'New Jersey', '34', 12],
  ['NM', 'New Mexico', '35', 3], ['NY', 'New York', '36', 26], ['NC', 'North Carolina', '37', 14],
  ['ND', 'North Dakota', '38', 1], ['OH', 'Ohio', '39', 15], ['OK', 'Oklahoma', '40', 5],
  ['OR', 'Oregon', '41', 6], ['PA', 'Pennsylvania', '42', 17], ['RI', 'Rhode Island', '44', 2],
  ['SC', 'South Carolina', '45', 7], ['SD', 'South Dakota', '46', 1], ['TN', 'Tennessee', '47', 9],
  ['TX', 'Texas', '48', 38], ['UT', 'Utah', '49', 4], ['VT', 'Vermont', '50', 1],
  ['VA', 'Virginia', '51', 11], ['WA', 'Washington', '53', 10], ['WV', 'West Virginia', '54', 2],
  ['WI', 'Wisconsin', '55', 8], ['WY', 'Wyoming', '56', 1],
].map(([postal, name, fips, house]) => ({ postal, name, fips, house }));

export const BY_POSTAL = Object.fromEntries(STATES.map((s) => [s.postal, s]));
export const BY_FIPS = Object.fromEntries(STATES.map((s) => [s.fips, s]));

// Class II Senate seats, regular elections in 2026.
export const SENATE_REGULAR = [
  'AL', 'AK', 'AR', 'CO', 'DE', 'GA', 'ID', 'IL', 'IA', 'KS', 'KY', 'LA', 'ME', 'MA', 'MI',
  'MN', 'MS', 'MT', 'NE', 'NH', 'NJ', 'NM', 'NC', 'OK', 'OR', 'RI', 'SC', 'SD', 'TN', 'TX',
  'VA', 'WV', 'WY',
];
// Special elections for the remainder of terms vacated in 2025.
export const SENATE_SPECIAL = ['FL', 'OH'];
export const SENATE_SOURCE_URL = 'https://ballotpedia.org/United_States_Senate_elections,_2026';

export const GOVERNOR = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'FL', 'GA', 'HI', 'ID', 'IL', 'IA', 'KS', 'ME',
  'MD', 'MA', 'MI', 'MN', 'NE', 'NV', 'NH', 'NM', 'NY', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'VT', 'WI', 'WY',
];
export const GOVERNOR_SOURCE_URL = 'https://ballotpedia.org/Gubernatorial_elections,_2026';
export const HOUSE_SOURCE_URL = 'https://ballotpedia.org/United_States_House_of_Representatives_elections,_2026';

export function stateFromName(text) {
  const t = ` ${text.toLowerCase()} `;
  // Longest names first so "West Virginia" wins over "Virginia".
  const sorted = [...STATES].sort((a, b) => b.name.length - a.name.length);
  for (const s of sorted) {
    const re = new RegExp(`[^a-z]${s.name.toLowerCase()}[^a-z]`);
    if (re.test(t)) return s.postal;
  }
  return null;
}
