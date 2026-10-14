// Display-name checks (Phase 11.13): abusive words (English + Hindi/Hinglish) and names that
// impersonate the app or its staff. Deliberately conservative to avoid blocking real names
// (e.g. "Rathod", "Chodankar", "Dickens", "Cassandra"):
//  - SUBSTRING words are long and unambiguous - matched anywhere after normalisation.
//  - WORD entries are short or ambiguous - matched only as whole words.
// This is a first line of defence; reports + moderation (Phase 26) handle the rest.

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i' };

const SUBSTRING = [
  'fuck',
  'bitch',
  'cunt',
  'whore',
  'slut',
  'nigger',
  'nigga',
  'faggot',
  'asshole',
  'motherf',
  'madarchod',
  'maderchod',
  'behenchod',
  'bhenchod',
  'benchod',
  'chutiya',
  'chutiye',
  'bhosdi',
  'bhosda',
  'bhosad',
  'gaandu',
  'randwa',
];

// Whole words only. Kept out of SUBSTRING on purpose: "shit" is inside "Ashita", "lauda" is a
// surname, "rapist" is inside "therapist", "gandu"/"chod" appear inside real surnames.
const WORD = [
  'shit',
  'ass',
  'dick',
  'cock',
  'pussy',
  'porn',
  'sex',
  'sexy',
  'nude',
  'boobs',
  'bastard',
  'rapist',
  'rape',
  'lund',
  'gand',
  'gandu',
  'chod',
  'chodu',
  'lauda',
  'laude',
  'lavda',
  'lavde',
  'lawda',
  'kamina',
  'kamine',
  'harami',
  'haramzada',
  'kutta',
  'kutti',
  'bsdk',
  'mkc',
];

// Names that pretend to be the app or its staff. "talklink" anywhere; the rest as whole words
// (so "Stafford" or "Supportina" are fine, "Admin" / "TalkLink Support" are not).
const RESERVED_ANYWHERE = ['talklink'];
const RESERVED_WORDS = [
  'admin',
  'administrator',
  'moderator',
  'mod',
  'support',
  'official',
  'staff',
  'team',
];

const normalise = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[0-9@$!]/g, (c) => LEET[c] || c);

const words = (s) =>
  normalise(s)
    .split(/[^a-z]+/)
    .filter(Boolean);
const compact = (s) => normalise(s).replace(/[^a-z]/g, '');

// Returns null when the name is fine, otherwise 'PROFANITY' | 'RESERVED'.
const checkName = (name) => {
  const c = compact(name);
  const w = words(name);
  if (SUBSTRING.some((bad) => c.includes(bad)) || w.some((t) => WORD.includes(t))) {
    return 'PROFANITY';
  }
  if (RESERVED_ANYWHERE.some((r) => c.includes(r)) || w.some((t) => RESERVED_WORDS.includes(t))) {
    return 'RESERVED';
  }
  return null;
};

module.exports = { checkName, SUBSTRING, WORD, normalise };
