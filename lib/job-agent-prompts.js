const JSON_RULE = "Return only valid JSON. Do not use markdown fences or add text outside the JSON.";

function safeJson(value) {
  return JSON.stringify(value ?? {}, null, 2).slice(0, 50000);
}

export function searchPlanPrompt(agent) {
  return {
    system: `You design high-recall, high-precision executive job-search plans. Build a city-first search strategy that starts with the user's ordered priority cities, then states/regions, then remote. Expand beyond obvious CIO and VP IT titles into business applications, enterprise platforms, commercial technology, manufacturing technology, data, AI, architecture, transformation, Office of the CIO, and senior director/head roles when the profile supports them. Never invent user qualifications. Keep queries practical for a public web search engine. ${JSON_RULE}`,
    user: `APPLICANT SEARCH PROFILE:\n${safeJson({
      profileSummary: agent.profile_summary,
      targetTitles: agent.target_titles,
      preferredTitleTerms: agent.preferred_title_terms,
      excludedTitleTerms: agent.excluded_title_terms,
      industries: agent.industries,
      roleKeywords: agent.role_keywords,
      excludedKeywords: agent.excluded_keywords,
      priorityCities: agent.priority_cities,
      states: agent.states,
      regions: agent.regions,
      remoteEligible: agent.remote_eligible,
      minimumBaseCompensation: agent.min_base_compensation,
      minimumTotalCompensation: agent.min_total_compensation,
    })}\n\nReturn this exact shape:\n{
      "titleFamilies":[
        {"label":"", "titles":[""]}
      ],
      "locationWaves":[
        {"label":"Greater Boston", "locations":["Boston, MA"], "priority":1}
      ],
      "queries":[
        {"query":"", "titleFamily":"", "location":"", "priority":1}
      ],
      "exclusionTerms":[""],
      "notes":[""]
    }\nRules:\n- Preserve the user's city order.\n- Put each named city into its own focused query wave before broader state or region searches.\n- Include remote as the final wave only when enabled.\n- Generate 18 to 50 total queries when the geography warrants it. Every named city must have coverage before deeper state, regional, or remote queries.\n- Queries must include one or more concrete titles plus one location.\n- Use compensation in queries only when it improves recall; do not assume employers publish pay.\n- Include close title variants that a broad national title search could miss.\n- Exclude recruiter, sales, finance, clinical-practice, and unrelated engineering titles unless explicitly targeted.`,
    json: true,
    temperature: 0.2,
  };
}

export function fitEvaluationPrompt(agent, jobs) {
  const compactJobs = jobs.map((job, index) => ({
    index,
    title: job.title,
    company: job.company,
    location: job.location,
    remote: job.remote,
    compensation: job.compensation_text,
    datePosted: job.date_posted,
    sourceUrl: job.source_url,
    description: String(job.description_text || "").slice(0, 7000),
  }));

  return {
    system: `You are an executive technology recruiter evaluating public job postings for one applicant. Separate mandatory qualifications from preferred qualifications. Do not infer experience the applicant has not stated. Treat specialized mandatory EHR/EMR, banking, insurance, clinical, legal, scientific, or hands-on software-product requirements as material gaps unless the posting explicitly accepts adjacent experience. Favor business-first enterprise technology leadership, manufacturing, life sciences, advanced manufacturing, aerospace and defense, industrial, energy, PE-backed, complex multi-site, Northeast, and US-remote roles. ${JSON_RULE}`,
    user: `APPLICANT PROFILE AND SEARCH RULES:\n${safeJson({
      profileSummary: agent.profile_summary,
      targetTitles: agent.target_titles,
      industries: agent.industries,
      roleKeywords: agent.role_keywords,
      excludedKeywords: agent.excluded_keywords,
      minBaseCompensation: agent.min_base_compensation,
      minTotalCompensation: agent.min_total_compensation,
    })}\n\nVERIFIED ACTIVE JOBS:\n${safeJson(compactJobs)}\n\nReturn this exact shape:\n{
      "evaluations":[
        {
          "index":0,
          "fitScore":0,
          "recommended":false,
          "fitSummary":"",
          "mandatoryQualifications":[""],
          "preferredQualifications":[""],
          "materialGaps":[""],
          "compensationAssessment":"meets|likely_meets|unclear|below",
          "whyIncludedOrExcluded":""
        }
      ]
    }\nRules:\n- Include one evaluation for every job index.\n- A role can be recommended with unclear compensation when level, company, incentives, or published range makes the threshold plausible.\n- Do not recommend obvious mismatches merely to increase result count.\n- Use 0-100 fit scores consistently.\n- Keep each text field concise and evidence-based.`,
    json: true,
    temperature: 0.15,
  };
}
