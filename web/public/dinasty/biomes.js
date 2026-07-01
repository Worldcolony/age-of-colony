// WorldColony — biome definitions: distinct switchable scenes
window.DN = window.DN || {};

DN.biomes = [
  {
    id: 'verdant', name: 'Verdant Basin', tag: 'Temperate forest',
    sky: { top: 0x6FA6DA, mid: 0x9FC9E8, bot: 0xA7C57E, sun: 0xFFF3D2 },
    fog: [180, 660], sunColor: 0xFFEFC8, sunBias: 1.0,
    hemiSky: 0xDCEBFF, hemiGround: 0x4A5A28, amb: 0.16,
    bg: 0xA7C57E, water: 0x66BBD8,
    ground: { grass: 0x5E9A35, grassDark: 0x42741F, grassLight: 0x7FB544, dirt: 0x8A6536, sand: 0xCBB682, rock: 0x9D988D, rockLight: 0xBAB4A7, rockDark: 0x7C776C },
    flora: { trunk: 0x6E4C2C, trunkDark: 0x533922, foliage: [0x4E8B38, 0x3E7A2C, 0x69A848], warm: 0xC98B33, trees: 56, grass: 3400, bushes: 40, rocks: 30, mush: 70, flowers: 90, ferns: 600, pineRatio: 0.5, warmRatio: 0.12 }
  },
  {
    id: 'canyon', name: 'Amber Canyon', tag: 'Arid badlands',
    sky: { top: 0x7FA0C4, mid: 0xCFC0A0, bot: 0xEAD9B8, sun: 0xFFE6AE },
    fog: [160, 600], sunColor: 0xFFE0A8, sunBias: 1.12,
    hemiSky: 0xF0E2C0, hemiGround: 0x6B4A28, amb: 0.2,
    bg: 0xEAD9B8, water: 0x57A6BE,
    ground: { grass: 0x9A8038, grassDark: 0x6E5524, grassLight: 0xC0A455, dirt: 0xB0633A, sand: 0xD9BE84, rock: 0xC07A4A, rockLight: 0xD89A66, rockDark: 0x8A4F2E },
    flora: { trunk: 0x7A5230, trunkDark: 0x5A3A22, foliage: [0xC98B33, 0xB5662B, 0x9A7D2E], warm: 0xCF5A2A, trees: 26, grass: 1500, bushes: 26, rocks: 54, mush: 24, flowers: 40, ferns: 200, pineRatio: 0.15, warmRatio: 0.7 }
  },
  {
    id: 'wetland', name: 'Twilight Wetland', tag: 'Dusk mire',
    sky: { top: 0x3C4E78, mid: 0x5E6E96, bot: 0x9088AA, sun: 0xFFD6A8 },
    fog: [90, 430], sunColor: 0xE6BC90, sunBias: 0.72,
    hemiSky: 0x7888A8, hemiGround: 0x283830, amb: 0.24,
    bg: 0x9088AA, water: 0x4A7E92,
    ground: { grass: 0x3E6B4A, grassDark: 0x274632, grassLight: 0x5C8E68, dirt: 0x4A4438, sand: 0x6E7060, rock: 0x5C6470, rockLight: 0x7A828C, rockDark: 0x42474F },
    flora: { trunk: 0x4A3A2E, trunkDark: 0x342820, foliage: [0x2E6B52, 0x255A45, 0x3E7D62], warm: 0x8A6BB0, trees: 60, grass: 3800, bushes: 44, rocks: 28, mush: 80, flowers: 70, ferns: 700, pineRatio: 0.6, warmRatio: 0.08 }
  },
  {
    id: 'frost', name: 'Frostpine Hollow', tag: 'Boreal snow',
    sky: { top: 0x6E8FB8, mid: 0xAFC4DC, bot: 0xDCE7EE, sun: 0xF2F6FF },
    fog: [150, 560], sunColor: 0xEAF0FF, sunBias: 0.9,
    hemiSky: 0xE6EEF8, hemiGround: 0x6A7480, amb: 0.22,
    bg: 0xDCE7EE, water: 0x86BBD0,
    ground: { grass: 0xCFDCE0, grassDark: 0xA9BCC4, grassLight: 0xEAF1F4, dirt: 0x8A8C90, sand: 0xBFC6C8, rock: 0x9AA2AA, rockLight: 0xC6CDD2, rockDark: 0x6E767E },
    flora: { trunk: 0x5A4636, trunkDark: 0x3E3024, foliage: [0x2E5A48, 0x356752, 0xDDE9EC], warm: 0xE8F1F4, trees: 56, grass: 1700, bushes: 30, rocks: 40, mush: 30, flowers: 36, ferns: 320, pineRatio: 0.85, warmRatio: 0.18 }
  }
];
