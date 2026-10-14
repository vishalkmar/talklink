// Generates the predefined illustrated avatars into backend/static/avatars/avatar_XX.svg.
// Usage: node scripts/generate-avatars.js   (re-run after changing the list below)
const fs = require('fs');
const path = require('path');

const OUT = path.resolve(__dirname, '../static/avatars');

const SKIN = ['#F9D3B4', '#EDB98A', '#D08B5B', '#AE5D29', '#8D5524', '#FFDBB4'];
const HAIR = ['#2C1B18', '#4A312C', '#A55728', '#D6B370', '#724133', '#B58143', '#E8E1E1'];
const BG = ['#22878F', '#7BC6CC', '#F7B267', '#F4845F', '#A0C4FF', '#BDB2FF', '#9BF6FF', '#CAFFBF'];
const SHIRT = ['#1B2A2F', '#F04A55', '#3D5A80', '#FFFFFF', '#6A994E', '#7B2CBF'];

// [skin, hair, bg, shirt, hairStyle, extras]
const AVATARS = [
  [0, 0, 0, 3, 'short', []],
  [1, 3, 2, 0, 'long', []],
  [2, 0, 4, 1, 'spiky', []],
  [3, 0, 3, 3, 'bun', ['earrings']],
  [4, 0, 1, 2, 'curly', ['beard']],
  [5, 2, 5, 4, 'long', ['glasses']],
  [1, 1, 6, 5, 'short', ['glasses', 'beard']],
  [0, 4, 7, 2, 'bob', []],
  [2, 6, 2, 0, 'bald', ['beard']],
  [3, 0, 0, 1, 'curly', ['earrings']],
  [5, 5, 4, 3, 'spiky', ['glasses']],
  [4, 0, 3, 4, 'bob', ['earrings']],
];

const hairBack = (style, c) =>
  ({
    long: `<path d="M68 118c0-44 26-74 60-74s60 30 60 74v78H68z" fill="${c}"/>`,
    bob: `<path d="M70 120c0-42 26-70 58-70s58 28 58 70v28c0 8-6 12-12 12H82c-6 0-12-4-12-12z" fill="${c}"/>`,
    bun: `<circle cx="128" cy="46" r="20" fill="${c}"/>`,
  })[style] || '';

const hairFront = (style, c) =>
  ({
    short: `<path d="M80 110c0-34 20-56 48-56s48 22 48 56c-10-16-26-24-48-24s-38 8-48 24z" fill="${c}"/>`,
    long: `<path d="M80 112c2-34 22-54 48-54s46 20 48 54c-14-22-30-28-48-28s-34 6-48 28z" fill="${c}"/>`,
    bob: `<path d="M80 112c2-34 22-54 48-54s46 20 48 54c-8-6-20-30-48-30s-40 24-48 30z" fill="${c}"/>`,
    bun: `<path d="M80 110c0-32 20-52 48-52s48 20 48 52c-12-18-28-24-48-24s-36 6-48 24z" fill="${c}"/>`,
    spiky: `<path d="M78 108l6-30 12 14 8-26 12 18 12-24 10 22 12-20 8 26 12-12 4 32c-14-16-30-22-48-22s-34 6-48 22z" fill="${c}"/>`,
    curly: [86, 102, 118, 134, 150, 166]
      .map((x, i) => `<circle cx="${x}" cy="${76 - (i % 2) * 8}" r="15" fill="${c}"/>`)
      .concat(
        `<circle cx="80" cy="96" r="12" fill="${c}"/><circle cx="176" cy="96" r="12" fill="${c}"/>`,
      )
      .join(''),
    bald: '',
  })[style] || '';

const extrasSvg = (extras, hairColor) =>
  extras
    .map(
      (e) =>
        ({
          glasses:
            '<g fill="none" stroke="#1B2A2F" stroke-width="4"><circle cx="110" cy="120" r="13"/><circle cx="146" cy="120" r="13"/><path d="M123 120h10"/></g>',
          beard: `<path d="M92 132c4 30 18 44 36 44s32-14 36-44c-8 12-20 18-36 18s-28-6-36-18z" fill="${hairColor}"/>`,
          earrings:
            '<circle cx="82" cy="140" r="5" fill="#F7B267"/><circle cx="174" cy="140" r="5" fill="#F7B267"/>',
        })[e],
    )
    .join('');

const avatarSvg = ([s, h, b, sh, style, extras]) => {
  const skin = SKIN[s];
  const hair = HAIR[h];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
<defs><clipPath id="c"><circle cx="128" cy="128" r="128"/></clipPath></defs>
<g clip-path="url(#c)">
<rect width="256" height="256" fill="${BG[b]}"/>
${hairBack(style, hair)}
<path d="M48 256c0-46 36-74 80-74s80 28 80 74z" fill="${SHIRT[sh]}"/>
<rect x="112" y="150" width="32" height="40" rx="14" fill="${skin}"/>
<ellipse cx="80" cy="124" rx="9" ry="12" fill="${skin}"/>
<ellipse cx="176" cy="124" rx="9" ry="12" fill="${skin}"/>
<ellipse cx="128" cy="118" rx="48" ry="56" fill="${skin}"/>
${hairFront(style, hair)}
<path d="M100 104q10-6 20 0M136 104q10-6 20 0" stroke="#1B2A2F" stroke-width="4" fill="none" stroke-linecap="round"/>
<circle cx="110" cy="120" r="5" fill="#1B2A2F"/>
<circle cx="146" cy="120" r="5" fill="#1B2A2F"/>
<path d="M112 146q16 14 32 0" stroke="#1B2A2F" stroke-width="4" fill="none" stroke-linecap="round"/>
<circle cx="98" cy="138" r="7" fill="#F04A55" opacity=".18"/>
<circle cx="158" cy="138" r="7" fill="#F04A55" opacity=".18"/>
${extrasSvg(extras, hair)}
</g>
</svg>
`;
};

fs.mkdirSync(OUT, { recursive: true });
AVATARS.forEach((a, i) => {
  const id = `avatar_${String(i + 1).padStart(2, '0')}`;
  fs.writeFileSync(path.join(OUT, `${id}.svg`), avatarSvg(a));
});
console.error(`Wrote ${AVATARS.length} avatars to ${OUT}`);
