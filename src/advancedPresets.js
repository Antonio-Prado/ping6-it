export const ADVANCED_PRESET_GROUPS = [
  {
    id: "top",
    label: "Advanced presets",
    presets: [
      {
        id: "top-5-regioni",
        label: "Top 5 regions",
        description: "Select 5 global probes with broad coverage.",
        settings: {
          from: "world",
          limit: 5,
          clearFilters: true,
        },
      },
      {
        id: "top-10-regioni",
        label: "Top 10 regions",
        description: "Select 10 global probes for wider coverage.",
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
    label: "Specific ISPs",
    presets: [
      {
        id: "isp-comcast",
        label: "Comcast (eyeball)",
        description: "Filter probes by Comcast ASN (access/consumer).",
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
        description: "Filter probes by Vodafone ASN in Europe.",
        settings: {
          from: "Europe",
          gpTag: "eyeball",
          asn: 1273,
          limit: 5,
          requireV6Capable: false,
          clearFilters: true,
          showAdvanced: true,
        },
      },
      {
        id: "isp-telekom",
        label: "Deutsche Telekom (eyeball)",
        description: "Filter probes by Deutsche Telekom ASN in Europe.",
        settings: {
          from: "Europe",
          gpTag: "eyeball",
          asn: 3320,
          limit: 5,
          clearFilters: true,
          showAdvanced: true,
        },
      },
    ],
  },
];
