#!/usr/bin/env node
/* =========================================================================
   Night Owl - Kolkata: dataset builder.

   Reads the hand-written curated seeds in tools/seed-locations.geojson, then fills
   in the rest of the city, locality by locality, so that wherever you finish a
   night shift there is something within a few kilometres.

   Run:   node tools/generate-locations.mjs
   Writes: data/locations.geojson

   READ THIS BEFORE TRUSTING THE OUTPUT
   ------------------------------------
   The seed entries are named after real Kolkata places. Everything added here is
   SYNTHETIC: plausible business names, street references and timings built from
   real localities and real road names, so the map is useful for demonstrating
   coverage - but none of it has been verified on the ground. Every generated
   feature carries `"source": "synthetic-fill"` so the two can never be confused.
   Phone numbers are deliberately not generated: a wrong number on a directory
   someone opens at 3:30 AM is worse than no number. See README.

   The build is deterministic (fixed PRNG seed), so re-running it produces a
   byte-identical file and clean diffs.
   ========================================================================= */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED_FILE = path.join(HERE, 'seed-locations.geojson');
const OUT_FILE = path.join(HERE, '..', 'data', 'locations.geojson');

const RNG_SEED = 20260918;
const TOTAL_TARGET = 400;     // total features in the output, seeds included
const JITTER_LAT = 0.0055;    // ~600 m box: entries stay inside their locality
const JITTER_LNG = 0.0065;

/* ------------------------------------------------------------------ random */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(RNG_SEED);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (min, max) => min + Math.floor(rnd() * (max - min + 1));
const chance = (p) => rnd() < p;
const jitter = (v, amount) => +(v + (rnd() - 0.5) * amount).toFixed(5);

/* ------------------------------------------------- local commerce name pools */

const SURNAMES = [
  'Banerjee', 'Chatterjee', 'Mukherjee', 'Ghosh', 'Bose', 'Das', 'Dutta', 'Sen', 'Roy',
  'Sarkar', 'Pal', 'Mitra', 'Basu', 'Saha', 'Dey', 'Nandi', 'Haldar', 'Chanda', 'Mondal',
  'Pramanik', 'Samanta', 'Guha', 'Lahiri', 'Ganguly', 'Chakraborty', 'Adhikary', 'Kar',
  'Seal', 'Bhattacharya', 'Sengupta', 'Bagchi', 'Sinha', 'Talukdar', 'Kundu', 'Bhowmik'
];

const CHAIN_PHARMACY = [
  'Apollo Pharmacy', 'MedPlus Pharmacy', 'Wellness Forever', 'Netmeds Store',
  'SastaSundar Pharmacy', 'Medicine Shoppe', 'Noble Chemist', 'Suraksha Pharmacy'
];

const PHARMACY_PATTERNS = [
  '{s} Pharmacy', '{s} Medical Hall', '{s} Chemist & Druggist', '{s} Medical Stores',
  '{s} Drug House', 'New {s} Pharmacy', 'Sree {s} Pharmacy', '{s} Brothers Pharmacy',
  '{s} Medi Point', '{s} Health Centre', 'LifeCare Medical', 'Aarogya Pharmacy',
  'Sanjivani Chemist', 'Nirmal Medical', '{s} Medicine Corner', 'Jan Aushadhi Kendra'
];

const FOOD_PATTERNS = [
  '{s} Roll Corner', 'Kolkata Roll Corner', 'Hot Roll Junction', 'Dada Boudi Roll Centre',
  '{l} Roll Centre', 'Hakka Chowmein Centre', '{s} Chinese Corner', 'Chowmein Gali',
  'Wok & Roll Fast Food', 'Golden Dragon Fast Food', 'Chung Wah Fast Food',
  '{s} Biriyani House', 'Bhai Bhai Biriyani', 'Kolkata Biriyani Counter', 'Mughlai Nights',
  '{s} Kabab Corner', '{s} Tea Stall', 'Adda Tea Stall', 'Chai Ghor', '{l} Tea Cabin',
  'Night Chai & Toast', '{s} Paratha Ghar', 'Dim Paratha Gali', 'Hotel {s} Fast Food',
  '{l} Puchka Corner', '{s} Ghugni & Churmur', 'Momos & More', '{s} Sandwich Corner',
  'Kolkata Street Bites', 'Mithai Ghar', '{l} Night Canteen', 'Shift Canteen',
  '{s} Hotel Night Kitchen', '{s} Egg Roll Centre', 'Bangali Bhojnalaya'
];

const FUEL_CHAIN = ['IndianOil', 'HP Petrol Pump', 'Bharat Petroleum', 'Reliance Petrol Pump',
  'Nayara Energy', 'Shell Petrol Pump'];

const FUEL_PATTERNS = [
  'IndianOil Petrol Pump - {l}', 'HP Petrol Pump - {l}', 'Bharat Petroleum - {l}',
  'Reliance Petrol Pump - {l}', 'Nayara Energy - {l}', 'Shell Petrol Pump - {l}',
  '{s} Filling Station', '{l} Service Station', '{s} Fuel Point', 'IndianOil - {l} Depot Road'
];

const MECHANIC_PATTERNS = [
  '{s} Tyre House', '{s} Motor Works', '{l} Auto Repair', 'Puncture & Air Point - {l}',
  '24x7 Bike Repair - {l}', '{s} Car Care Centre', 'Roadside Mechanic Point - {l}'
];

const TRANSIT_PATTERNS = [
  '{l} Auto Stand', '{l} Bus Terminus', '{l} Minibus Stand', '{l} App Cab Pickup Bay',
  '{l} Police Kiosk Pickup Point', '{l} Night Bus Bay', '{l} Crossing Night Auto Stand',
  '{l} Tram Depot Pickup', '{l} Taxi Stand'
];

const METRO_NAMES = {
  'Dum Dum': 'Dum Dum', Belgachia: 'Belgachia', Shyambazar: 'Shyambazar',
  Shobhabazar: 'Shobhabazar Sutanuti', 'Girish Park': 'Girish Park',
  'Mahatma Gandhi Road': 'Mahatma Gandhi Road', Central: 'Central',
  'Chandni Chowk': 'Chandni Chowk', Esplanade: 'Esplanade', 'Park Street': 'Park Street',
  Maidan: 'Maidan', 'Rabindra Sadan': 'Rabindra Sadan', 'Netaji Bhavan': 'Netaji Bhavan',
  Kalighat: 'Kalighat', 'Rabindra Sarobar': 'Rabindra Sarobar', Tollygunge: 'Tollygunge',
  Bansdroni: 'Masterda Surya Sen', 'New Garia': 'Kavi Subhash', Phoolbagan: 'Phoolbagan',
  Sealdah: 'Sealdah', 'Salt Lake Sector V': 'Salt Lake Sector V',
  Karunamoyee: 'Karunamoyee', 'Salt Lake Sector III': 'Central Park',
  'Salt Lake Stadium': 'Salt Lake Stadium', 'Howrah Station': 'Howrah'
};

/* ------------------------------------------------------------------- notes */

const PHARMACY_NOTES = [
  'Night shutter on the {street} side; UPI works after 1 AM.',
  'Keeps insulin and cardiac stock behind the counter - ask directly.',
  'Small shop, surprisingly deep stock. Ring the bell if the shutter is half down.',
  'A/C waiting area, and the staff will call a cab for you at closing time.',
  'Free first-aid and BP check through the night.',
  'Cold-chain fridge for insulin, with generator backup during load-shedding.',
  'Sells single strips and loose tablets, which most night counters will not.',
  'Dialysis and oxygen suppliers on call - ask at the counter.'
];

const FOOD_NOTES = [
  'Chowmein, egg roll and chai right through the small hours. Cash preferred.',
  'Peak queue after 2 AM; the egg-chicken double roll is the standard order.',
  'Opens for the night-shift crowd - paratha and egg curry till sunrise.',
  'Bench seating under a tarpaulin. Fine in the rain, better in winter.',
  'Ask for the night plate: smaller portion, lower price, same taste.',
  'Cash and UPI both work; the owner keeps change for cab drivers.',
  'The kettle stays on the boil all night; toast-butter is the house staple.',
  'Woks only fire up after 7 PM; before that it is a tea shop.',
  'Sells to taxi and auto drivers at a fixed night rate - ask for it.',
  'Maggi, omelette and chai until about 4 AM, then shuts for the morning market.'
];

const FOOD_DAWN_NOTES = [
  'Opens at 4 AM - the closest thing to breakfast if your shift ends at 3:30.',
  'Dawn kitchen: stew, bread and tea for the shift-change crowd from 4 AM.',
  'By 4:30 there is a queue of night-shift workers here. Worth the wait.'
];

const FUEL_NOTES = [
  'Air and tyre inflator on the far side; attended all night.',
  'Bright forecourt - the safest fill-up point on this stretch.',
  'Card and UPI work at the night counter.',
  'Tyre pressure gauge kept behind the counter - ask for it.',
  'Sells sealed engine oil and coolant at night as well.',
  'Two attendants on duty after midnight, one always at the pump.'
];

const MECHANIC_NOTES = [
  'Puncture repair, jump-start and tow hook-up. Call before you roll in.',
  'Night puncture shop: mostly tyres, but they will look at a dead battery.',
  'Keeps a few spare tubes for scooters, which is the usual 2 AM problem.',
  'Tows to the nearest workshop if the damage is beyond a puncture.'
];

const TRANSIT_SAFETY = [
  'Lit forecourt, CCTV on the gate and a police kiosk within 50 m.',
  'Street lamps on all arms of the crossing; still busy at 3 AM.',
  'Prepaid or app cab strongly preferred over a flagged cab at this hour.',
  'Guarded gate with floodlights; the security desk keeps a cab log.',
  'Main-road frontage with a 24h tea stall alongside, so you are not alone.',
  'Staffed police kiosk and an ambulance bay on the same stretch.',
  'Auto drivers wait along the kerb - agree the fare before getting in.',
  'Share the vehicle number with someone before you get in.'
];

const TRANSIT_NOTES = [
  'Metro shuts around 22:45; the roadside cab point thins out well before midnight.',
  'Cabs are easiest to find between 2 AM and 4 AM, when the shifts change.',
  'Night buses leave from the lit island platform.',
  'Ask at the kiosk if you feel unsure about a cab - they will note the number.'
];

/* ---------------------------------------------------------------- localities
   name, lat, lng, weight (relative density), profile, streets, metro?
   Coordinates are locality centres, good to a few hundred metres. Streets are
   real roads in that locality.                                                       */

const LOCALITIES = [
  ['Esplanade', 22.5640, 88.3510, 5, 'core', ['Chowringhee Road', 'S. N. Banerjee Road', 'Bentinck Street'], true],
  ['Dalhousie Square', 22.5715, 88.3495, 4, 'core', ['Netaji Subhas Road', 'Old Court House Street', 'Fairlie Place']],
  ['Chandni Chowk', 22.5665, 88.3585, 4, 'market', ['Rabindra Sarani', 'Chandni Chowk Street', 'Bepin Behari Ganguly Street'], true],
  ['Burrabazar', 22.5800, 88.3560, 4, 'market', ['Mahatma Gandhi Road', 'Canning Street', 'Rabindra Sarani']],
  ['Bowbazar', 22.5680, 88.3610, 4, 'market', ['Bepin Behari Ganguly Street', 'Surya Sen Street', 'College Street']],
  ['College Street', 22.5760, 88.3630, 4, 'market', ['College Street', 'Bidhan Sarani', 'Mahatma Gandhi Road']],
  ['Sealdah', 22.5675, 88.3720, 4, 'transit', ['Acharya Prafulla Chandra Road', 'Bepin Behari Ganguly Street', 'Sealdah Station Road'], true],
  ['Entally', 22.5645, 88.3780, 3, 'residential', ['Acharya Prafulla Chandra Road', 'Anath Nath Deb Lane', 'C. I. T. Road']],
  ['Taltala', 22.5530, 88.3615, 3, 'market', ['Simla Street', 'Taltala Lane', 'A. J. C. Bose Road']],
  ['Park Street', 22.5535, 88.3520, 5, 'core', ['Park Street', 'Chowringhee Road', 'Middleton Street'], true],
  ['New Market', 22.5585, 88.3520, 5, 'market', ['Hogg Street', 'Bertram Street', 'Lindsay Street']],
  ['Park Circus', 22.5395, 88.3690, 5, 'core', ['Syed Amir Ali Avenue', 'Suhrawardy Avenue', 'A. J. C. Bose Road']],
  ['Minto Park', 22.5450, 88.3540, 3, 'core', ['A. J. C. Bose Road', 'Sarat Bose Road', 'Elgin Road']],
  ['Bhowanipore', 22.5370, 88.3470, 4, 'residential', ['Ashutosh Mukherjee Road', 'Hazra Road', 'Sarat Bose Road'], true],
  ['Kalighat', 22.5200, 88.3430, 4, 'market', ['Shyama Prasad Mukherjee Road', 'Hazra Road', 'Kali Temple Road'], true],
  ['Alipore', 22.5330, 88.3330, 3, 'residential', ["Judge's Court Road", 'B. M. Road', 'Belvedere Road']],
  ['Tollygunge', 22.4990, 88.3480, 4, 'transit', ['Deshapran Sashmal Road', 'Tollygunge Circular Road', 'N. S. C. Bose Road'], true],
  ['Maidan', 22.5560, 88.3430, 3, 'core', ['Mayo Road', 'Cathedral Road', 'Outram Road'], true],
  ['Rabindra Sadan', 22.5440, 88.3460, 3, 'core', ['Cathedral Road', 'A. J. C. Bose Road', 'Maidan Row'], true],
  ['Rashbehari', 22.5130, 88.3520, 4, 'market', ['Rashbehari Avenue', 'Lake Gardens Road', 'Southern Avenue']],
  ['Ballygunge', 22.5240, 88.3650, 4, 'core', ['Ballygunge Circular Road', 'Rashbehari Avenue', 'Ballygunge Place']],
  ['Gariahat', 22.5180, 88.3690, 6, 'market', ['Gariahat Road', 'Rashbehari Avenue', 'Hindustan Park']],
  ['Golpark', 22.5120, 88.3660, 3, 'market', ['Gariahat Road', 'Dhaka Road', 'Rammohan Roy Road']],
  ['Dhakuria', 22.5080, 88.3680, 3, 'market', ['Dhakuria Bridge Road', 'Prince Anwar Shah Road', 'Rammohan Roy Road']],
  ['Jadavpur', 22.4990, 88.3710, 4, 'market', ['Raja S. C. Mallick Road', 'Jadavpur Central Road', 'Prince Anwar Shah Road']],
  ['Jodhpur Park', 22.5080, 88.3620, 3, 'residential', ['Jodhpur Park Road', 'Lake View Road', 'Prince Anwar Shah Road']],
  ['Kidderpore', 22.5400, 88.3230, 4, 'residential', ['Diamond Harbour Road', 'Mominpore Road', 'K. B. Sarani']],
  ['Watgunge', 22.5450, 88.3280, 3, 'residential', ['K. B. Sarani', 'Garden Reach Road', 'Diamond Harbour Road']],
  ['Hastings', 22.5520, 88.3300, 3, 'residential', ['Strand Road', 'K. B. Sarani', 'Mayo Road']],
  ['Babughat', 22.5570, 88.3390, 3, 'transit', ['Strand Road', 'Babughat Approach Road', 'Mayo Road']],
  ['Princep Ghat', 22.5560, 88.3360, 3, 'market', ['Strand Road', 'St. Georges Gate Road', 'Princep Ghat Approach']],
  ['Metiabruz', 22.5180, 88.2870, 3, 'residential', ['Garden Reach Road', 'Metiabruz Road', 'Bichali Ghat Road']],
  ['Garden Reach', 22.5430, 88.3050, 4, 'residential', ['Garden Reach Road', 'Paharpur Road', 'Bichali Ghat Road']],
  ['Taratala', 22.5080, 88.3130, 3, 'highway', ['Diamond Harbour Road', 'Taratala Road', 'M. G. Road']],
  ['Behala Chowrasta', 22.5010, 88.3150, 5, 'market', ['Diamond Harbour Road', 'James Long Sarani', 'Behala Chowrasta Road']],
  ['Sakherbazar', 22.4980, 88.3040, 3, 'residential', ['Diamond Harbour Road', 'Sakherbazar Road', 'James Long Sarani']],
  ['Thakurpukur', 22.4830, 88.3000, 3, 'residential', ['Diamond Harbour Road', 'Thakurpukur Bazar Road', 'James Long Sarani']],
  ['Parnasree', 22.5050, 88.3000, 3, 'residential', ['Parnasree Pally Road', 'Diamond Harbour Road', 'Behala Station Road']],
  ['Sarsuna', 22.4880, 88.2920, 2, 'residential', ['Diamond Harbour Road', 'Sarsuna Main Road', 'Ho Chi Minh Sarani']],
  ['Haridevpur', 22.4940, 88.3320, 3, 'residential', ['Haridevpur Road', 'Tollygunge Circular Road', 'M. G. Road']],
  ['Naktala', 22.4930, 88.3560, 3, 'residential', ['Naktala Road', 'N. S. C. Bose Road', 'Bansdroni Road']],
  ['Bansdroni', 22.4890, 88.3620, 3, 'residential', ['Bansdroni Road', 'N. S. C. Bose Road', 'Netaji Nagar Road'], true],
  ['Garia', 22.4700, 88.3720, 4, 'transit', ['Garia Main Road', 'N. S. C. Bose Road', 'Boral Main Road']],
  ['New Garia', 22.4750, 88.3970, 3, 'transit', ['Satyen Roy Road', 'N. S. C. Bose Road', 'Garia Station Road'], true],
  ['Patuli', 22.4740, 88.3880, 3, 'residential', ['Bypass Connector', 'Patuli Main Road', 'Baishnabghata Road']],
  ['Baghajatin', 22.4810, 88.3770, 3, 'residential', ['Baghajatin Road', 'Raja S. C. Mallick Road', 'Briji Road']],
  ['Bikramgarh', 22.4870, 88.3890, 2, 'residential', ['Bikramgarh Road', 'Sarat Park Road', 'Baghajatin Road']],
  ['Santoshpur', 22.4880, 88.3890, 3, 'residential', ['Santoshpur Main Road', 'Kavi Nazrul Road', 'Ajoy Nagar Road']],
  ['Mukundapur', 22.4990, 88.3980, 3, 'highway', ['E. M. Bypass', 'Mukundapur Main Road', 'Nayabad Road']],
  ['Anandapur', 22.5090, 88.4020, 3, 'highway', ['E. M. Bypass', 'Anandapur Main Road', 'Ruby Hospital Road']],
  ['Science City', 22.5400, 88.4020, 3, 'highway', ['E. M. Bypass', 'J. B. S. Haldane Avenue', 'Science City Approach Road']],
  ['Barakhola', 22.4940, 88.3940, 2, 'residential', ['Barakhola Road', 'E. M. Bypass', 'Santoshpur Road']],
  ['Kalikapur', 22.4960, 88.4090, 3, 'residential', ['Kalikapur Road', 'E. M. Bypass', 'Kustia Road']],
  ['Panchasayar', 22.4820, 88.4160, 2, 'residential', ['Panchasayar Road', 'Sector B Road', 'Nayabad Road']],
  ['Nayabad', 22.4870, 88.4210, 2, 'residential', ['Nayabad Main Road', 'Panchasayar Road', 'Kalikapur Road']],
  ['Kasba', 22.5160, 88.3900, 4, 'market', ['Kasba Road', 'Rashbehari Connector', 'Ballygunge Place East']],
  ['Topsia', 22.5420, 88.3850, 3, 'market', ['Topsia Road', 'Bhagat Singh Road', 'Anwar Shah Road']],
  ['Tangra', 22.5480, 88.3900, 4, 'market', ['New China Bazar Road', 'Tangra Road', 'Beliaghata Main Road']],
  ['Beliaghata', 22.5700, 88.4000, 3, 'residential', ['Beliaghata Main Road', 'E. M. Bypass', 'C. I. T. Road']],
  ['VIP Bazar', 22.5310, 88.4070, 3, 'highway', ['VIP Road', 'E. M. Bypass', 'Kalikapur Road']],

  ['Shyambazar', 22.5990, 88.3690, 5, 'market', ['Bidhan Sarani', 'Bhairab Dutta Lane', 'B. T. Road'], true],
  ['Shobhabazar', 22.5950, 88.3630, 3, 'residential', ['Rabindra Sarani', 'Bidhan Sarani', 'Sovabazar Street'], true],
  ['Bagbazar', 22.6000, 88.3600, 3, 'residential', ['Rabindra Sarani', 'Bagbazar Street', 'B. K. Paul Avenue']],
  ['Chitpur', 22.5930, 88.3580, 4, 'market', ['Chitpur Road', 'Rabindra Sarani', 'Cossipore Road']],
  ['Cossipore', 22.6120, 88.3620, 3, 'residential', ['Cossipore Road', 'B. T. Road', 'Kali Charan Ghosh Road']],
  ['Sinthee', 22.6090, 88.3720, 3, 'residential', ['B. T. Road', 'Sinthee More', 'Dumdum Road']],
  ['Belgachia', 22.6050, 88.3830, 3, 'transit', ['Belgachia Road', 'B. T. Road', 'Dumdum Road'], true],
  ['Tala', 22.6100, 88.3790, 3, 'residential', ['Tala Road', 'B. T. Road', 'Paikpara Row']],
  ['Girish Park', 22.5910, 88.3600, 3, 'market', ['Rabindra Sarani', 'Bidhan Sarani', 'Chittaranjan Avenue'], true],
  ['Mahatma Gandhi Road', 22.5850, 88.3620, 3, 'market', ['Mahatma Gandhi Road', 'Rabindra Sarani', 'Canning Street'], true],
  ['Maniktala', 22.5850, 88.3750, 4, 'market', ['Acharya Prafulla Chandra Road', 'Maniktala Main Road', 'Vivekananda Road']],
  ['Kankurgachi', 22.5800, 88.3880, 4, 'market', ['C. I. T. Road', 'Kankurgachi Road', 'Ultadanga Main Road']],
  ['Phoolbagan', 22.5770, 88.3830, 3, 'residential', ['Phoolbagan Road', 'C. I. T. Road', 'Narkeldanga Main Road'], true],
  ['Ultadanga', 22.5920, 88.3950, 4, 'transit', ['Ultadanga Main Road', 'Canal Road', 'VIP Road Connector']],
  ['Kestopur', 22.6050, 88.4130, 4, 'residential', ['Kestopur Main Road', 'VIP Road', 'Baguiati Road']],
  ['Lake Town', 22.6050, 88.4020, 4, 'market', ['Lake Town Block B Road', 'Jessore Road', 'VIP Road']],
  ['Bangur Avenue', 22.6080, 88.4080, 3, 'residential', ['Bangur Avenue', 'Jessore Road', 'Lake Town Road']],
  ['Dum Dum Road', 22.6180, 88.4050, 3, 'residential', ['Dumdum Road', 'Jessore Road', 'Nagerbazar Road']],
  ['Nagerbazar', 22.6250, 88.4130, 4, 'market', ['Nagerbazar Road', 'Jessore Road', 'Dumdum Road']],
  ['Dum Dum', 22.6350, 88.4050, 3, 'transit', ['Jessore Road', 'Dumdum Road', 'Station Road'], true],
  ['Birati', 22.6620, 88.4200, 3, 'residential', ['Jessore Road', 'Birati Station Road', 'Michael Nagar Road']],
  ['Michael Nagar', 22.6650, 88.4100, 2, 'residential', ['Michael Nagar Road', 'Jessore Road', 'Dumdum Road']],
  ['Airport', 22.6540, 88.4470, 3, 'transit', ['VIP Road', 'Airport Gate Road', 'Jessore Road']],
  ['Rajarhat New Town', 22.5870, 88.4650, 4, 'tech', ['Major Arterial Road', 'New Town Road', 'Action Area I Road']],
  ['New Town AA II', 22.5980, 88.4750, 3, 'tech', ['Major Arterial Road', 'AA II Road', 'Chinar Park Road']],
  ['Chinar Park', 22.6150, 88.4550, 3, 'highway', ['Chinar Park More', 'Jessore Road', 'VIP Road']],
  ['Baguiati', 22.6120, 88.4350, 4, 'market', ['VIP Road', 'Baguiati Road', 'Jessore Road']],
  ['Teghoria', 22.6180, 88.4300, 3, 'residential', ['VIP Road', 'Teghoria Main Road', 'Baguiati Road']],
  ['Hatiara', 22.6230, 88.4450, 2, 'residential', ['Hatiara Road', 'VIP Road', 'Rajarhat Road']],
  ['Madhyamgram', 22.7000, 88.4450, 3, 'residential', ['Jessore Road', 'Madhyamgram Station Road', 'Badra Main Road']],
  ['Barasat', 22.7220, 88.4800, 3, 'transit', ['Jessore Road', 'Barasat Station Road', 'Nabapally Road']],
  ['Baranagar', 22.6380, 88.3720, 3, 'residential', ['B. T. Road', 'Baranagar Road', 'Gopal Lal Thakur Road']],
  ['Belghoria', 22.6500, 88.3900, 4, 'residential', ['B. T. Road', 'Belghoria Station Road', 'Feeder Road']],
  ['Nimta', 22.6650, 88.3900, 2, 'residential', ['Nimta Road', 'Feeder Road', 'B. T. Road']],
  ['Sodepur', 22.6900, 88.3900, 3, 'highway', ['B. T. Road', 'Sodepur Road', 'Station Road']],
  ['Panihati', 22.6880, 88.3720, 2, 'residential', ['B. T. Road', 'Panihati Station Road', 'Ghosh Para Road']],
  ['Khardah', 22.7020, 88.3770, 2, 'residential', ['B. T. Road', 'Khardah Station Road', 'Rahuta Road']],
  ['Barrackpore', 22.7620, 88.3720, 3, 'transit', ['B. T. Road', 'Barrackpore Station Road', 'Talpukur Road']],

  ['Salt Lake Sector I', 22.5870, 88.4080, 4, 'tech', ['Broadway Road', 'Sector I Road', 'Kestopur Bridge Road']],
  ['Salt Lake Sector II', 22.5860, 88.4180, 4, 'tech', ['Broadway Road', 'Sector II Road', 'Central Park Road']],
  ['Salt Lake Sector III', 22.5810, 88.4050, 4, 'tech', ['Sector III Road', 'Broadway Road', 'Bidhannagar Road'], true],
  ['Karunamoyee', 22.5860, 88.4180, 4, 'transit', ['Broadway Road', 'Karunamoyee Road', 'Sector II Road'], true],
  ['Salt Lake Sector V', 22.5735, 88.4320, 5, 'tech', ['DN Block Road', 'Sector V Road', 'College More Road'], true],
  ['College More', 22.5760, 88.4360, 3, 'transit', ['College More', 'Sector V Road', 'DN Block Road']],
  ['Salt Lake Stadium', 22.5690, 88.4080, 3, 'transit', ['Stadium Approach Road', 'Sector III Road', 'Broadway Road'], true],

  ['Howrah Station', 22.5835, 88.3420, 5, 'transit', ['Old Complex Road', 'Station Road', 'Grand Trunk Road'], true],
  ['Shibpur', 22.5730, 88.3200, 4, 'residential', ['Grand Trunk Road', 'Shibpur Road', 'College Road']],
  ['Salkia', 22.5960, 88.3350, 3, 'residential', ['Grand Trunk Road', 'Salkia Road', 'Golabari Road']],
  ['Golabari', 22.5880, 88.3400, 3, 'market', ['Grand Trunk Road', 'Golabari Road', 'Salkia Road']],
  ['Liluah', 22.6250, 88.3400, 3, 'residential', ['Grand Trunk Road', 'Liluah Station Road', 'Bhattanagar Road']],
  ['Belur', 22.6360, 88.3470, 3, 'residential', ['Grand Trunk Road', 'Belur Math Road', 'Bally Road']],
  ['Bally', 22.6500, 88.3450, 3, 'transit', ['Grand Trunk Road', 'Bally Station Road', 'Bally Halt Road']],
  ['Bhattanagar', 22.6100, 88.3300, 2, 'residential', ['Bhattanagar Road', 'Grand Trunk Road', 'Liluah Road']],
  ['Santragachi', 22.5850, 88.3000, 3, 'transit', ['Santragachi Station Road', 'Andul Road', 'Kona Expressway']],
  ['Andul', 22.5850, 88.2800, 2, 'residential', ['Andul Road', 'Grand Trunk Road', 'Kona Expressway']],
  ['Dhulagarh', 22.6100, 88.2700, 2, 'highway', ['Kona Expressway', 'Dhulagarh Road', 'N. H. 6']],
  ['Domjur', 22.6200, 88.2400, 2, 'highway', ['Kona Expressway', 'Domjur Road', 'N. H. 6']]
];

/* Category mix per locality profile. Values are weights, normalised per locality. */
const PROFILE_MIX = {
  core:        { pharmacy: 30, food: 30, fuel: 18, transit: 24 },
  market:      { pharmacy: 22, food: 44, fuel: 16, transit: 22 },
  transit:     { pharmacy: 18, food: 28, fuel: 20, transit: 36 },
  tech:        { pharmacy: 30, food: 36, fuel: 20, transit: 16 },
  highway:     { pharmacy: 14, food: 22, fuel: 50, transit: 14 },
  residential: { pharmacy: 34, food: 26, fuel: 20, transit: 20 }
};

/* Hours. Each bucket is [weight, open, close, always, closedDays, label]. */
const HOURS = {
  /* Skewed hard to the night: this directory is read at 3:30 AM, so roughly six in
     ten chemists here stay up, and the daytime-only ones exist so the "Open now"
     filter has something real to exclude at any hour. */
  pharmacy: [
    { w: 58, always: true },
    { w: 18, open: '08:00', close: '02:30' },
    { w: 9, open: '09:00', close: '01:00' },
    { w: 7, open: '07:00', close: '23:30' },
    { w: 4, open: '09:00', close: '21:00', closedDays: [0] },
    { w: 4, open: '08:00', close: '04:00' }
  ],
  food: [
    { w: 20, open: '17:00', close: '05:00' },
    { w: 14, open: '19:00', close: '06:00' },
    { w: 22, open: '11:00', close: '04:00' },
    { w: 12, open: '18:00', close: '03:30' },
    { w: 10, open: '20:00', close: '04:30' },
    { w: 6, always: true },
    { w: 8, open: '04:00', close: '10:30', dawn: true },
    { w: 8, open: '10:00', close: '23:30' }
  ],
  fuel: [
    { w: 62, always: true },
    { w: 12, open: '05:00', close: '01:00' },
    { w: 10, open: '06:00', close: '23:30' },
    { w: 8, open: '21:00', close: '06:00', mechanic: true },
    { w: 8, open: '09:00', close: '21:00', mechanic: true, closedDays: [0] }
  ],
  transit: [
    { w: 46, always: true },
    { w: 18, open: '05:00', close: '23:30' },
    { w: 20, open: '20:00', close: '06:00' },
    { w: 10, open: '05:30', close: '22:45' },
    { w: 6, open: '04:30', close: '23:00' }
  ]
};

/* --------------------------------------------------------------- generation */

const seedDoc = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
const seeds = seedDoc.features.map((f) => {
  const p = f.properties;
  p.source = 'curated-seed';
  p.locality = p.locality || localityFromAddress(p.address);
  return f;
});

function localityFromAddress(address) {
  const hit = LOCALITIES.find(([name]) => address && address.includes(name));
  return hit ? hit[0] : 'Kolkata';
}

function pickHours(category) {
  const buckets = HOURS[category];
  const total = buckets.reduce((sum, b) => sum + b.w, 0);
  let roll = rnd() * total;
  for (const bucket of buckets) {
    roll -= bucket.w;
    if (roll <= 0) {
      const out = {};
      if (bucket.always) out.always = true;
      if (bucket.open) out.open = bucket.open;
      if (bucket.close) out.close = bucket.close;
      if (bucket.closedDays) out.closedDays = bucket.closedDays.slice();
      if (bucket.dawn) out.dawn = true;
      if (bucket.mechanic) out.mechanic = true;
      return out;
    }
  }
  return { always: true };
}

function hoursLabel(hours) {
  if (hours.always) return 'Open 24 hours';
  const open = hours.open;
  const close = hours.close;
  const suffix = hours.closedDays ? ', closed Sunday' : ' daily';
  return `${open} - ${close}${suffix}`;
}

const usedNames = new Set();
const usedIds = new Set();

/*
 * Names must be unique within the file. The retry has to redraw from the whole pool,
 * not retry one fixed pattern: patterns such as "Momos & More" or a branded chain have
 * no {s} slot, so every retry of the same pattern produced the same string, burned all
 * 40 attempts and landed on the fallback - which appended the locality a second time
 * ("Reliance Petrol Pump - Science City - Science City 7"). Redraw the pattern too.
 */
function uniqueName(pool, localityName, disambiguator) {
  const build = (pattern) => {
    const name = pattern.replace('{s}', pick(SURNAMES)).replace('{l}', localityName);
    return name.includes(localityName) ? name : `${name} - ${localityName}`;
  };

  for (let attempt = 0; attempt < 80; attempt++) {
    const full = build(pick(pool));
    if (!usedNames.has(full)) { usedNames.add(full); return full; }
  }

  // Practically unreachable; a street qualifier reads like a real disambiguation.
  const full = `${build(pick(pool))} (${disambiguator})`;
  usedNames.add(full);
  return full;
}

function addressFor(locality, streets) {
  const street = pick(streets);
  const number = chance(0.35)
    ? `${int(1, 40)}/${int(1, 9)}`
    : `${int(1, 180)}${chance(0.25) ? pick(['A', 'B', 'C']) : ''}`;
  return `${number}, ${street}, ${locality[0]}`;
}

function buildFeature(category, locality, index) {
  const [name, lat, lng, , profile, streets, hasMetro] = locality;
  const hours = pickHours(category);
  const street = pick(streets);
  let title;
  let notes;
  let safety;
  let tags;
  let fuel = false;

  if (category === 'pharmacy') {
    title = uniqueName(chance(0.34) ? CHAIN_PHARMACY : PHARMACY_PATTERNS, name, street);
    notes = pick(PHARMACY_NOTES).replace('{street}', street);
  } else if (category === 'food') {
    title = uniqueName(FOOD_PATTERNS, name, street);
    notes = hours.dawn ? pick(FOOD_DAWN_NOTES) : pick(FOOD_NOTES);
  } else if (category === 'fuel') {
    if (hours.mechanic) { title = uniqueName(MECHANIC_PATTERNS, name, street); notes = pick(MECHANIC_NOTES); fuel = true; }
    else { title = uniqueName(FUEL_PATTERNS, name, street); notes = pick(FUEL_NOTES); }
  } else {
    if (hasMetro && METRO_NAMES[name] && chance(0.3)) {
      const station = METRO_NAMES[name];
      // Station names are authoritative, so no {l} slot: "Central Metro Station - Exit 2",
      // not "Chandni Chowk Metro Station - Chandni Chowk".
      title = uniqueName([
        `${station} Metro Station - Cab Point`,
        `${station} Metro Station - Exit 2`,
        `${station} Metro Station - Prepaid Taxi Rank`
      ], name, street);
      notes = pick(TRANSIT_NOTES);
      hours.open = '05:30'; hours.close = '22:45'; delete hours.always;
    } else {
      title = uniqueName(TRANSIT_PATTERNS, name, street);
      notes = chance(0.5) ? pick(TRANSIT_NOTES) : null;
    }
    safety = pick(TRANSIT_SAFETY);
  }

  if (fuel) fuel = true;

  tags = [name.toLowerCase(), street.toLowerCase(), category];
  if (category === 'pharmacy') tags.push('chemist', 'medicine', '24 hours', 'night');
  if (category === 'food') tags.push('street food', 'late night', 'chai', 'rolls', 'night');
  if (category === 'fuel') tags.push(hours.mechanic ? 'mechanic' : 'petrol', 'diesel', 'night');
  if (category === 'transit') tags.push('pickup', 'safe', 'auto', 'taxi', 'night');

  const props = {
    name: title,
    category,
    locality: name,
    address: addressFor(locality, streets),
    ...hours,
    hours: hoursLabel(hours),
    tags
  };
  if (notes) props.notes = notes;
  if (safety) props.safety = safety;
  if (hours.always) delete props.open, delete props.close;
  delete props.dawn;
  delete props.mechanic;
  props.source = 'synthetic-fill';
  props.verified = null;

  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [jitter(lng, JITTER_LNG), jitter(lat, JITTER_LAT)] },
    properties: props
  };
}

/*
 * Two-step category allocation.
 *
 * Rounding the profile mix inside each locality separately loses the small slices:
 * a 2-slot locality can never carry fuel's 16% share, so pumps quietly evaporated
 * and the city ended up with a third as many filling stations as it should have.
 * So: average the profile mixes into one city-wide target, then fill slot by slot
 * against the global deficit, weighted by each locality's own preference. Result: the
 * market areas still get their food, the highways their pumps, and the city-wide mix
 * lands on target instead of drifting.
 */
function planCategories(totals) {
  const CATEGORIES = ['pharmacy', 'food', 'fuel', 'transit'];
  const budget = totals.reduce((a, b) => a + b, 0);
  const target = { pharmacy: 0, food: 0, fuel: 0, transit: 0 };

  LOCALITIES.forEach((locality, i) => {
    const mix = PROFILE_MIX[locality[4]];
    const sum = CATEGORIES.reduce((s, k) => s + mix[k], 0);
    for (const k of CATEGORIES) target[k] += (totals[i] * mix[k]) / sum;
  });

  const plan = totals.map(() => ({ pharmacy: 0, food: 0, fuel: 0, transit: 0 }));
  const assigned = { pharmacy: 0, food: 0, fuel: 0, transit: 0 };
  const maxTotal = Math.max(...totals);
  const used = (i) => plan[i].pharmacy + plan[i].food + plan[i].fuel + plan[i].transit;

  /* Phase 1 - essentials. Pure global balancing left 49 localities with no food at all:
     the deficit maths kept feeding slots to whichever category was furthest behind
     nationally, and small residential localities lost out. A chemist and something hot
     to eat are the two things you actually need at 3:30 AM, so every locality gets
     one of each before anything else is decided. */
  LOCALITIES.forEach((locality, i) => {
    if (used(i) < totals[i]) { plan[i].pharmacy += 1; assigned.pharmacy += 1; }
    if (used(i) < totals[i]) { plan[i].food += 1; assigned.food += 1; }
  });

  /* Phase 2 - arterial coverage. Pumps and pickup points belong on the busy roads, not
     in every lane, so the profiles that front a highway, a station or a commercial
     core claim one of each while they still have slots. */
  const ARTERIAL = new Set(['core', 'market', 'transit', 'tech', 'highway']);
  LOCALITIES.forEach((locality, i) => {
    if (!ARTERIAL.has(locality[4])) return;
    if (used(i) < totals[i]) { plan[i].fuel += 1; assigned.fuel += 1; }
    if (used(i) < totals[i]) { plan[i].transit += 1; assigned.transit += 1; }
  });

  // Phase 3 - everything still unfilled, by profile-weighted global deficit.
  for (let round = 0; round < maxTotal; round++) {
    LOCALITIES.forEach((locality, i) => {
      if (used(i) >= totals[i]) return;
      const cap = Math.max(1, Math.ceil(totals[i] * 0.6));
      const under = CATEGORIES.filter((k) => plan[i][k] < cap);
      const pool = under.length ? under : CATEGORIES;   // never stall on the cap
      const mix = PROFILE_MIX[locality[4]];
      let best = pool[0];
      let bestScore = -Infinity;
      for (const k of pool) {
        // Global deficit dominates; the locality's own mix only breaks ties.
        const deficit = (target[k] - assigned[k]) / Math.max(1, budget);
        const score = deficit * 6 + mix[k] / 200 + rnd() * 0.02;
        if (score > bestScore) { bestScore = score; best = k; }
      }
      plan[i][best] += 1;
      assigned[best] += 1;
    });
  }

  return plan;
}

const seedByCategory = { pharmacy: [], food: [], fuel: [], transit: [] };
for (const f of seeds) {
  const bucket = seedByCategory[f.properties.category];
  if (bucket) bucket.push(f);
  else throw new Error(`seed has unknown category: ${f.properties.category}`);
}

const generated = { pharmacy: [], food: [], fuel: [], transit: [] };
const weightTotal = LOCALITIES.reduce((sum, l) => sum + l[3], 0);
const budget = Math.max(0, TOTAL_TARGET - seeds.length);
const localityCounts = LOCALITIES.map((l) => (l[3] / weightTotal) * budget);
const floorCounts = localityCounts.map((v) => Math.max(2, Math.floor(v)));
let short = budget - floorCounts.reduce((a, b) => a + b, 0);
const fracOrder = localityCounts
  .map((v, i) => ({ i, frac: v - Math.floor(v) }))
  .sort((a, b) => b.frac - a.frac);
while (short > 0) {
  for (const item of fracOrder) { if (short <= 0) break; floorCounts[item.i] += 1; short -= 1; }
}

const categoryPlan = planCategories(floorCounts);

LOCALITIES.forEach((locality, i) => {
  for (const [category, count] of Object.entries(categoryPlan[i])) {
    for (let n = 0; n < count; n++) {
      generated[category].push(buildFeature(category, locality, n));
    }
  }
});

/* ------------------------------------------------- night coverage guarantee
   The point of this directory is 3:30 AM. Left to chance, a handful of localities
   end up with nothing open at that hour and the person standing there sees an empty
   list. So after generation, every locality is forced to have at least two places
   open at 03:30 - converting its own synthetic entries, never a curated seed.     */

const NIGHT_MINUTES = 3 * 60 + 30;
const NEED_ORDER = { pharmacy: 0, fuel: 1, transit: 2, food: 3 };

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function isNightOpen(p) {
  if (p.always) return true;
  const o = toMinutes(p.open);
  const c = toMinutes(p.close);
  return c <= o
    ? NIGHT_MINUTES >= o || NIGHT_MINUTES < c
    : NIGHT_MINUTES >= o && NIGHT_MINUTES < c;
}

function makeNight(p) {
  p.closedDays && delete p.closedDays;
  if (p.category === 'food') {
    p.open = '19:00';
    p.close = '06:00';
    p.hours = '19:00 - 06:00 daily';
  } else {
    p.always = true;
    delete p.open;
    delete p.close;
    p.hours = 'Open 24 hours';
  }
  p.nightGuaranteed = true;
}

function ensureNightCoverage(rows) {
  const byLocality = new Map();
  for (const f of rows) {
    const key = f.properties.locality;
    if (!byLocality.has(key)) byLocality.set(key, []);
    byLocality.get(key).push(f);
  }

  const candidates = (list) => list
    .filter((f) => f.properties.source === 'synthetic-fill')
    .sort((a, b) => NEED_ORDER[a.properties.category] - NEED_ORDER[b.properties.category]);

  let fixed = 0;
  for (const list of byLocality.values()) {
    const lit = list.filter((f) => isNightOpen(f.properties));
    if (lit.length >= 2) continue;
    const openCats = new Set(lit.map((f) => f.properties.category));
    for (const candidate of candidates(list)) {
      if (list.filter((f) => isNightOpen(f.properties)).length >= 2) break;
      if (openCats.has(candidate.properties.category)) continue;
      makeNight(candidate.properties);
      openCats.add(candidate.properties.category);
      fixed += 1;
    }
  }
  return fixed;
}

const PREFIX = { pharmacy: 'ph', food: 'fd', fuel: 'fu', transit: 'tr' };
const features = [];
for (const category of ['pharmacy', 'food', 'fuel', 'transit']) {
  const rows = [...seedByCategory[category], ...generated[category]];
  rows.forEach((f, index) => {
    const id = `${PREFIX[category]}-${String(index + 1).padStart(3, '0')}`;
    if (usedIds.has(id)) throw new Error(`duplicate id ${id}`);
    usedIds.add(id);
    // id last: seed properties carry their own id, and the spread would win otherwise.
    features.push({
      type: 'Feature',
      geometry: f.geometry,
      properties: { ...f.properties, id }
    });
  });
}

const nightFixed = ensureNightCoverage(features);

const out = {
  type: 'FeatureCollection',
  name: 'night-owl-kolkata',
  generated: '2026-09-18',
  generator: 'tools/generate-locations.mjs',
  seed: RNG_SEED,
  license: 'ODbL-1.0 (data), MIT (code)',
  disclaimer:
    'MIXED-PROVENANCE SAMPLE DATA. Curated seeds name real Kolkata places; ' +
    'synthetic-fill entries are generated from real localities and road names but are ' +
    'NOT real businesses, and no timing here is verified. Coordinates are locality-accurate ' +
    'to a few hundred metres, not to a doorstep. Phone numbers are intentionally absent. ' +
    'Verify independently before relying on any entry - especially at 3 AM.',
  schema: {
    id: 'string, stable slug, used for deep links (#ph-001)',
    name: 'string, place name',
    category: 'pharmacy | food | fuel | transit',
    locality: 'string, the neighbourhood the entry sits in',
    address: 'string, street-level address (synthetic for generated entries)',
    source: 'curated-seed | synthetic-fill',
    always: 'boolean, true when open 24x7 (open/close omitted)',
    open: 'HH:MM local, opening time',
    close: 'HH:MM local; earlier than open means the window wraps past midnight',
    closedDays: 'array of ints, 0 = Sunday. omitted means all week',
    hours: 'string, human readable hours',
    phone: 'string, optional. Empty throughout this sample - see README',
    notes: 'string, optional night-specific tip',
    safety: 'string, optional, transit points only',
    tags: 'array of strings, extra search keywords',
    nightGuaranteed: 'true when these hours were adjusted by the coverage pass so that this locality is never empty at 03:30',
    verified: 'ISO date of last ground check, or null'
  },
  counts: features.reduce((acc, f) => {
    acc[f.properties.category] = (acc[f.properties.category] || 0) + 1;
    return acc;
  }, { total: features.length, localities: LOCALITIES.length }),
  nightCoverage: {
    referenceHour: '03:30',
    openAtReference: features.filter((f) => isNightOpen(f.properties)).length,
    localitiesWithAtLeastTwoOpen: new Set(
      features.filter((f) => isNightOpen(f.properties)).map((f) => f.properties.locality)
    ).size,
    localitiesTotal: new Set(features.map((f) => f.properties.locality)).size,
    entriesAdjustedForCoverage: nightFixed
  },
  features
};

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + '\n');

const size = (fs.statSync(OUT_FILE).size / 1024).toFixed(0);
console.log(`wrote ${path.relative(process.cwd(), OUT_FILE)}`);
console.log(`  ${features.length} places across ${LOCALITIES.length} localities, ${size} KB`);
console.log('  ' + JSON.stringify(out.counts));
