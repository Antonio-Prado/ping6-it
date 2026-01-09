// src/geoPresets.js
// Macro regions + sub-regions (UN M49). Oceania is included under Asia as requested.
//
// NOTE: we keep using Globalping's `magic` string because App.jsx already supports tags
// via "+eyeball/+datacenter" suffixes on the `from` string.

export const GEO_PRESETS = [
  {
    id: "eu",
    label: "Europe",
    magic: "Europe",
    sub: [
      { id: "eu-w", label: "West", magic: "Western Europe" },
      { id: "eu-n", label: "North", magic: "Northern Europe" },
      { id: "eu-s", label: "South", magic: "Southern Europe" },
      { id: "eu-e", label: "East", magic: "Eastern Europe" },
    ],
  },
  {
    id: "na",
    label: "North America",
    magic: "North America",
    sub: [
      { id: "na-n", label: "Northern America", magic: "Northern America" },
      { id: "na-c", label: "Central America", magic: "Central America" },
      { id: "na-car", label: "Caribbean", magic: "Caribbean" },
    ],
  },
  {
    id: "sa",
    label: "South America",
    magic: "South America",
    sub: [
      { id: "sa-all", label: "All South America", magic: "South America" },
      { id: "sa-br", label: "Brazil", magic: "Brazil" },
      { id: "sa-ar", label: "Argentina", magic: "Argentina" },
      { id: "sa-cl", label: "Chile", magic: "Chile" },
      { id: "sa-co", label: "Colombia", magic: "Colombia" },
    ],
  },
  {
    id: "af",
    label: "Africa",
    magic: "Africa",
    sub: [
      { id: "af-n", label: "Northern Africa", magic: "Northern Africa" },
      { id: "af-w", label: "Western Africa", magic: "Western Africa" },
      { id: "af-m", label: "Middle Africa", magic: "Middle Africa" },
      { id: "af-e", label: "Eastern Africa", magic: "Eastern Africa" },
      { id: "af-s", label: "Southern Africa", magic: "Southern Africa" },
    ],
  },
  {
    id: "as",
    label: "Asia",
    magic: "Asia",
    sub: [
      { id: "as-w", label: "Western Asia", magic: "Western Asia" },
      { id: "as-c", label: "Central Asia", magic: "Central Asia" },
      { id: "as-s", label: "Southern Asia", magic: "Southern Asia" },
      { id: "as-se", label: "South-eastern Asia", magic: "South-eastern Asia" },
      { id: "as-e", label: "Eastern Asia", magic: "Eastern Asia" },

      // Oceania moved under Asia (as requested)
      { id: "oc-anz", label: "Oceania · Australia & NZ", magic: "Australia and New Zealand" },
      { id: "oc-mel", label: "Oceania · Melanesia", magic: "Melanesia" },
      { id: "oc-mic", label: "Oceania · Micronesia", magic: "Micronesia" },
      { id: "oc-pol", label: "Oceania · Polynesia", magic: "Polynesia" },
    ],
  },
  {
    id: "world",
    label: "World",
    magic: "world",
    sub: [],
  },
];
