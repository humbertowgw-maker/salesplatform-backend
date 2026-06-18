const CORE_MODULES = [
  "Dashboard",
  "Leads",
  "Research",
  "Calendar",
  "AI Coaching",
  "Analytics",
  "Market Intelligence",
  "Feature Requests",
  "Settings",
];

const WGW_MODULES = [
  "Dashboard",
  "Leads",
  "Calendar",
  "Reps",
  "Look Up Tools",
  "Lead Search",
  "Call Logs",
  "Sales Trainer",
  "Users",
  "Analytics",
  "Team",
  "Director",
  "Market Intelligence",
  "Feature Requests",
  "Settings",
];

const PRESETS = {
  general_crm: {
    key: "general_crm",
    name: "General CRM",
    modules: CORE_MODULES,
    wording: {
      customerSingular: "account",
      customerPlural: "accounts",
      leadSingular: "lead",
      leadPlural: "leads",
      repSingular: "rep",
      repPlural: "reps",
      pipelineName: "Pipeline",
      appointmentName: "meeting",
    },
    pipelineStages: ["New", "Contacted", "Qualified", "Proposal", "Won", "Lost"],
    researchTools: ["Google Places", "Company Website", "LinkedIn", "Secretary of State"],
  },
  telecom: {
    key: "telecom",
    name: "Telecom / WGW",
    modules: WGW_MODULES,
    wording: {
      customerSingular: "business",
      customerPlural: "businesses",
      leadSingular: "lead",
      leadPlural: "leads",
      repSingular: "rep",
      repPlural: "reps",
      pipelineName: "Lead Pipeline",
      appointmentName: "appointment",
    },
    pipelineStages: ["New", "Called", "Texted", "No Answer", "Voicemail", "Follow Up", "Appt Set", "Not Interested", "Converted"],
    researchTools: ["Google Places", "FCC Broadband", "Carrier Lookup", "Secretary of State", "Apollo Owner Lookup"],
  },
  pest_control: {
    key: "pest_control",
    name: "Pest Control",
    modules: CORE_MODULES.concat(["Reps", "Call Logs"]),
    wording: {
      customerSingular: "property",
      customerPlural: "properties",
      leadSingular: "service lead",
      leadPlural: "service leads",
      repSingular: "technician",
      repPlural: "technicians",
      pipelineName: "Service Pipeline",
      appointmentName: "inspection",
    },
    pipelineStages: ["New", "Inspection Scheduled", "Inspected", "Quote Sent", "Follow Up", "Won", "Lost"],
    researchTools: ["Google Places", "Property Records", "Maps", "Review Sites"],
  },
  real_estate: {
    key: "real_estate",
    name: "Real Estate",
    modules: CORE_MODULES.concat(["Team"]),
    wording: {
      customerSingular: "contact",
      customerPlural: "contacts",
      leadSingular: "prospect",
      leadPlural: "prospects",
      repSingular: "agent",
      repPlural: "agents",
      pipelineName: "Deal Pipeline",
      appointmentName: "showing",
    },
    pipelineStages: ["New", "Nurturing", "Buyer/Seller Consult", "Active", "Offer", "Under Contract", "Closed", "Lost"],
    researchTools: ["MLS Notes", "County Assessor", "Maps", "Zillow", "LinkedIn"],
  },
  solar: {
    key: "solar",
    name: "Solar",
    modules: CORE_MODULES.concat(["Reps", "Director"]),
    wording: {
      customerSingular: "homeowner",
      customerPlural: "homeowners",
      leadSingular: "solar lead",
      leadPlural: "solar leads",
      repSingular: "consultant",
      repPlural: "consultants",
      pipelineName: "Solar Pipeline",
      appointmentName: "site survey",
    },
    pipelineStages: ["New", "Qualified", "Site Survey", "Design", "Proposal", "Contract Sent", "Installed", "Lost"],
    researchTools: ["Google Maps", "Sun Exposure", "Utility Territory", "Permit Records"],
  },
  insurance: {
    key: "insurance",
    name: "Insurance",
    modules: CORE_MODULES.concat(["Call Logs"]),
    wording: {
      customerSingular: "policyholder",
      customerPlural: "policyholders",
      leadSingular: "quote lead",
      leadPlural: "quote leads",
      repSingular: "producer",
      repPlural: "producers",
      pipelineName: "Quote Pipeline",
      appointmentName: "consultation",
    },
    pipelineStages: ["New", "Contacted", "Needs Analysis", "Quoted", "Follow Up", "Bound", "Lost"],
    researchTools: ["Carrier Appetite", "Public Records", "LinkedIn", "Company Website"],
  },
  home_services: {
    key: "home_services",
    name: "Home Services",
    modules: CORE_MODULES.concat(["Reps", "Call Logs", "Director"]),
    wording: {
      customerSingular: "customer",
      customerPlural: "customers",
      leadSingular: "job lead",
      leadPlural: "job leads",
      repSingular: "field rep",
      repPlural: "field reps",
      pipelineName: "Job Pipeline",
      appointmentName: "estimate",
    },
    pipelineStages: ["New", "Estimate Scheduled", "Estimate Complete", "Quote Sent", "Follow Up", "Won", "Lost"],
    researchTools: ["Google Places", "Maps", "Review Sites", "Permit Records"],
  },
};

function getPreset(key = "general_crm") {
  return PRESETS[key] || PRESETS.general_crm;
}

function buildConfig(row = {}) {
  const preset = getPreset(row.industry_key);
  return {
    industry_key: preset.key,
    industry_name: preset.name,
    enabled_modules: row.enabled_modules || preset.modules,
    custom_wording: { ...preset.wording, ...(row.custom_wording || {}) },
    pipeline_stages: row.pipeline_stages || preset.pipelineStages,
    research_tools: row.research_tools || preset.researchTools,
  };
}

module.exports = { PRESETS, getPreset, buildConfig };
