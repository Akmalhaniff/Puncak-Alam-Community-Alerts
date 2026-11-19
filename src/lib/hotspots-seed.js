// Starting list of flood-prone spots, from the "UPDATE BANDAR PUNCAK ALAM" WhatsApp group (Apr 2025 – Nov 2026).
// days = number of separate days with flood messages about the spot. Locations are approximate.
// Copied into the `hotspots` table once, when that table is empty; after that the admin edits them in /admin.

const REPEATED = { ms: 'Banyak kali dilapor banjir.', en: 'Reported flooded many times.' };
const NOV_LIST = { ms: 'Dalam senarai tempat banjir Nov 2026.', en: 'On the Nov 2026 list of flooded spots.' };
const KNEE = { ms: 'Pernah air paras lutut.', en: 'Water has reached knee height.' };
const same = v => ({ ms: v, en: v });

export const HOTSPOT_SEED = [
  { name: same('Avatar (Jalan Bukit Cerakah)'), lat: 3.24649, lng: 101.47193, days: 27, note: { ms: 'Paling kerap banjir. Ada kereta tenggelam. Biasanya banjir lepas Paya Jaras dan Sg Buloh.', en: 'Floods most often. Cars have been submerged. Usually floods after Paya Jaras and Sg Buloh.' } },
  { name: same('Depan Zombie Seafood'), lat: 3.19552, lng: 101.43315, days: 26, note: { ms: 'Antara tempat paling kerap banjir. Selalu orang tanya "ada banjir selain Zombie?"', en: 'One of the most often flooded spots. People often ask "anywhere flooded besides Zombie?"' } },
  { name: same('Depan Proton'), lat: 3.24086, lng: 101.44138, days: 14, note: { ms: 'Air selalu naik di sini. Kadang-kadang masih boleh lalu.', en: 'Water often rises here. Sometimes you can still pass.' } },
  { name: same('Alam Suria / Simpang 4'), lat: 3.23543, lng: 101.40706, days: 12, note: KNEE },
  { name: { ms: 'Keluar LATAR Puncak Alam', en: 'LATAR Puncak Alam exit' }, lat: 3.27346, lng: 101.45929, days: 11, note: { ms: 'Banjir di jalan masuk dan keluar LATAR.', en: 'Floods on the roads into and out of LATAR.' } },
  { name: { ms: 'Bulatan Daunan', en: 'Daunan roundabout' }, lat: 3.26205, lng: 101.45191, days: 10, note: { ms: 'Sungai melimpah ke arah Ijok.', en: 'The river overflows toward Ijok.' } },
  { name: { ms: 'Paya Jaras (pasar malam)', en: 'Paya Jaras (night market)' }, lat: 3.1997, lng: 101.54617, days: 9, note: { ms: 'Banjir awal. Tanda Avatar mungkin banjir selepas ini.', en: 'Floods early: a sign Avatar may flood next.' } },
  { name: same('Alam Jaya'), lat: 3.25373, lng: 101.44533, days: 9, note: REPEATED },
  { name: same('Alam Budiman'), lat: 3.14262, lng: 101.47938, days: 9, note: { ms: 'Jalan keluar ke Shah Alam. Banjir dan jem.', en: 'Route out to Shah Alam. Floods and traffic jams.' } },
  { name: { ms: 'Kg Bukit Hijau (bawah LATAR)', en: 'Kg Bukit Hijau (under LATAR)' }, lat: 3.25604, lng: 101.38092, days: 8, note: { ms: 'Jalan rendah bawah lebuh raya.', en: 'Low road under the highway.' } },
  { name: same('Hillpark'), lat: 3.21458, lng: 101.45654, days: 7, note: REPEATED },
  { name: same('Persiaran Mokhtar Dahari'), lat: 3.22319, lng: 101.45622, days: 7, note: { ms: 'Jalan utama keluar. Hati-hati dekat Eco Grandeur.', en: 'Main road out. Take care near Eco Grandeur.' } },
  { name: same('Alam Perdana'), lat: 3.25542, lng: 101.45731, days: 7, note: REPEATED },
  { name: same('Depan McD (Eco Grandeur)'), lat: 3.2217, lng: 101.44787, days: 6, note: NOV_LIST },
  { name: same('Parit Mahang'), lat: 3.30856, lng: 101.37849, days: 6, note: KNEE },
  { name: same('Eco Grandeur'), lat: 3.22413, lng: 101.46826, days: 5, note: REPEATED },
  { name: same('Ijok – Caledonia'), lat: 3.29458, lng: 101.43576, days: 1, note: NOV_LIST },
];
