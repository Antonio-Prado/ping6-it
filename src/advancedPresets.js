export const ADVANCED_PRESET_GROUPS = [
  {
    id: "top",
    label: "Preset avanzati",
    presets: [
      {
        id: "top-5-regioni",
        label: "Top 5 regioni",
        description: "Seleziona 5 probe globali con copertura ampia.",
        settings: {
          from: "world",
          limit: 5,
          clearFilters: true,
        },
      },
      {
        id: "top-10-regioni",
        label: "Top 10 regioni",
        description: "Seleziona 10 probe globali per una copertura più ampia.",
        settings: {
          from: "world",
          limit: 10,
          clearFilters: true,
        },
      },
    ],
  },
  {
    id: "isp",
    label: "ISP specifici",
    presets: [
      {
        id: "isp-comcast",
        label: "Comcast (eyeball)",
        description: "Filtra le probe Comcast tramite ASN (access/consumer).",
        settings: {
          from: "North America",
          gpTag: "eyeball",
          asn: 7922,
          limit: 5,
          clearFilters: true,
          showAdvanced: true,
        },
      },
      {
        id: "isp-vodafone",
        label: "Vodafone (eyeball)",
        description: "Filtra le probe Vodafone tramite ASN in Europa.",
        settings: {
          from: "Europe",
          gpTag: "eyeball",
          asn: 1273,
          limit: 5,
          clearFilters: true,
          showAdvanced: true,
        },
      },
      {
        id: "isp-telekom",
        label: "Deutsche Telekom (eyeball)",
        description: "Filtra le probe Deutsche Telekom tramite ASN in Europa.",
        settings: {
          from: "Europe",
          gpTag: "eyeball",
          asn: 3320,
          limit: 5,
          clearFilters: true,
          showAdvanced: true,
        },
      },
      {
        id: "isp-cloudflare",
        label: "Cloudflare (datacenter)",
        description: "Filtra le probe Cloudflare tramite ASN (datacenter).",
        settings: {
          from: "world",
          gpTag: "datacenter",
          asn: 13335,
          limit: 5,
          requireV6Capable: false,
          clearFilters: true,
          showAdvanced: true,
        },
      },
      {
        id: "isp-google",
        label: "Google (datacenter)",
        description: "Filtra le probe Google tramite ASN (datacenter).",
        settings: {
          from: "world",
          gpTag: "datacenter",
          asn: 15169,
          limit: 5,
          requireV6Capable: false,
          clearFilters: true,
          showAdvanced: true,
        },
      },
    ],
  },
];
