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
        description: "Filtra le probe Comcast (access/consumer).",
        settings: {
          from: "North America",
          gpTag: "eyeball",
          isp: "Comcast",
          limit: 5,
          clearFilters: true,
          showAdvanced: true,
        },
      },
      {
        id: "isp-vodafone",
        label: "Vodafone (eyeball)",
        description: "Filtra le probe Vodafone in Europa.",
        settings: {
          from: "Europe",
          gpTag: "eyeball",
          isp: "Vodafone",
          limit: 5,
          clearFilters: true,
          showAdvanced: true,
        },
      },
      {
        id: "isp-telekom",
        label: "Deutsche Telekom (eyeball)",
        description: "Filtra le probe Deutsche Telekom in Europa.",
        settings: {
          from: "Europe",
          gpTag: "eyeball",
          isp: "Deutsche Telekom",
          limit: 5,
          clearFilters: true,
          showAdvanced: true,
        },
      },
      {
        id: "isp-cloudflare",
        label: "Cloudflare (datacenter)",
        description: "Filtra le probe Cloudflare (datacenter).",
        settings: {
          from: "world",
          gpTag: "datacenter",
          isp: "Cloudflare",
          limit: 5,
          clearFilters: true,
          showAdvanced: true,
        },
      },
      {
        id: "isp-google",
        label: "Google (datacenter)",
        description: "Filtra le probe Google (datacenter).",
        settings: {
          from: "world",
          gpTag: "datacenter",
          isp: "Google",
          limit: 5,
          clearFilters: true,
          showAdvanced: true,
        },
      },
    ],
  },
];
