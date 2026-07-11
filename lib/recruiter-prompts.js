import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const JSON_RULE = "Return only a valid JSON object. Do not use markdown fences or add text outside JSON.";
const cache = new Map();

async function loadSkill(name) {
  if (cache.has(name)) return cache.get(name);
  const p = fileURLToPath(new URL(`../skills/${name}.md`, import.meta.url));
  const text = await fs.readFile(p, "utf8");
  cache.set(name, text);
  return text;
}

function jobText(job) {
  return JSON.stringify({
    title: job.title,
    companyName: job.company_name || job.companyName || "",
    roleDescription: job.role_description || job.roleDescription || "",
    responsibilities: job.responsibilities || [],
    mustHave: job.must_have || job.mustHave || [],
    preferredQualifications: job.preferred_qualifications || job.preferredQualifications || [],
    niceToHave: job.nice_to_have || job.niceToHave || [],
    screeningQuestions: job.screening_questions || job.screeningQuestions || [],
    rawDescription: job.raw_description || job.rawDescription || ""
  });
}

export async function structureJob(sourceText, context = {}) {
  const skill = await loadSkill("job-designer");
  return {
    system: `${skill}\n\nYou are now performing the extraction-and-structuring step. ${JSON_RULE}`,
    user: `SOURCE TYPE: ${context.sourceType || "paste"}\nSOURCE URL: ${context.sourceUrl || ""}\nKNOWN TITLE: ${context.title || ""}\nKNOWN COMPANY: ${context.companyName || ""}\nKNOWN START DATE: ${context.startDate || ""}\n\nSOURCE CONTENT:\n${sourceText}\n\nReturn exactly this shape:\n{
      "title":"",
      "companyName":"",
      "startDate":"YYYY-MM-DD or empty",
      "roleDescription":"",
      "responsibilities":[""],
      "mustHave":[""],
      "preferredQualifications":[""],
      "niceToHave":[""],
      "screeningQuestions":[""],
      "metadata":{"location":"","employmentType":"","seniority":"","reportingTo":"","warnings":[""]}
    }`,
    json: true,
    temperature: 0.2
  };
}

export async function jobBuilderChat(messages, currentDraft = {}) {
  const skill = await loadSkill("job-designer");
  return {
    system: `${skill}\n\nYou are in an interactive job-builder chat. ${JSON_RULE}`,
    user: `CURRENT DRAFT:\n${JSON.stringify(currentDraft || {})}\n\nCHAT:\n${messages.map(m => `${m.speaker.toUpperCase()}: ${m.message}`).join("\n")}\n\nReturn exactly:\n{
      "message":"brief conversational reply with up to three questions, or a note that the draft is ready",
      "ready":true,
      "draft":{"title":"","companyName":"","startDate":"","roleDescription":"","responsibilities":[],"mustHave":[],"preferredQualifications":[],"niceToHave":[],"screeningQuestions":[],"metadata":{}}
    }\nSet ready=false until the minimum drafting criteria are met. Preserve valid existing draft content.`,
    json: true,
    temperature: 0.35
  };
}

export async function rankCandidate(job, candidate) {
  return {
    system: `You are a senior recruiting analyst. Evaluate only job-related evidence. Ignore names and demographic signals. Never infer protected characteristics. Distinguish missing resume evidence from a confirmed skills gap. Do not auto-reject; provide explainable human decision support. ${JSON_RULE}`,
    user: `JOB PROFILE:\n${jobText(job)}\n\nCANDIDATE RESUME:\n${candidate.resume_text || candidate.resumeText || ""}\n\nReturn exactly:\n{
      "score":0,
      "recommendation":"strong_yes|yes|maybe|no",
      "summary":"two-sentence evidence-based assessment",
      "strengths":[""],
      "concerns":[""],
      "matchedRequirements":[""],
      "missingRequirements":[""],
      "reasons":["specific reason for score"],
      "interviewFocus":["highest-value issue to validate"]
    }\nScore from 0 to 100. Use no as a screening recommendation, not an automated disposition.`,
    json: true,
    temperature: 0.2
  };
}

export async function interviewStart(job, candidate) {
  const skill = await loadSkill("recruiter-interviewer");
  return {
    system: `${skill}\n\nInitialize a recruiter role-play session. ${JSON_RULE}`,
    user: `JOB:\n${jobText(job)}\n\nCANDIDATE:\n${candidate.resume_text || ""}\n\nRANKING CONTEXT:\n${JSON.stringify({ score: candidate.score, recommendation: candidate.recommendation, concerns: candidate.ranking_concerns, missing: candidate.missing_requirements, focus: candidate.interview_focus })}\n\nReturn exactly:\n{
      "candidateOpening":"a natural two- or three-sentence greeting as the candidate, grounded in the resume",
      "coachWelcome":"brief instruction to the recruiter",
      "suggestedFirstQuestion":"the best opening question",
      "coverage":{"currentRole":false,"motivation":false,"mustHaves":false,"gaps":false,"leadership":false,"outcomes":false,"logistics":false,"candidateQuestions":false},
      "riskAreas":[""]
    }`,
    json: true,
    temperature: 0.35
  };
}

export async function interviewTurn(job, candidate, turns, recruiterQuestion, coverage) {
  const skill = await loadSkill("recruiter-interviewer");
  return {
    system: `${skill}\n\nContinue the role-play. ${JSON_RULE}`,
    user: `JOB:\n${jobText(job)}\n\nCANDIDATE RESUME:\n${candidate.resume_text || ""}\n\nCURRENT COVERAGE:\n${JSON.stringify(coverage || {})}\n\nTRANSCRIPT:\n${turns.map(t => `${t.speaker.toUpperCase()}: ${t.message}`).join("\n")}\nRECRUITER: ${recruiterQuestion}\n\nReturn exactly:\n{
      "candidateAnswer":"realistic answer using only supported facts; acknowledge unknowns",
      "questionAssessment":"brief coaching feedback",
      "coverage":{"currentRole":false,"motivation":false,"mustHaves":false,"gaps":false,"leadership":false,"outcomes":false,"logistics":false,"candidateQuestions":false},
      "unresolvedRisks":[""],
      "suggestedNextQuestion":"single best next question",
      "questionQualityScore":0
    }`,
    json: true,
    temperature: 0.45
  };
}

export async function interviewFinish(job, candidate, turns, coverage) {
  const skill = await loadSkill("recruiter-interviewer");
  return {
    system: `${skill}\n\nClose and assess the recruiter practice session. ${JSON_RULE}`,
    user: `JOB:\n${jobText(job)}\n\nCANDIDATE RESUME:\n${candidate.resume_text || ""}\n\nFINAL COVERAGE:\n${JSON.stringify(coverage || {})}\n\nTRANSCRIPT:\n${turns.map(t => `${t.speaker.toUpperCase()}: ${t.message}`).join("\n")}\n\nReturn exactly:\n{
      "interviewQualityScore":0,
      "summary":"",
      "evidenceGathered":[""],
      "remainingUnknowns":[""],
      "questioningStrengths":[""],
      "questioningImprovements":[""],
      "recommendedFollowUps":[""],
      "coverage":{"currentRole":false,"motivation":false,"mustHaves":false,"gaps":false,"leadership":false,"outcomes":false,"logistics":false,"candidateQuestions":false}
    }`,
    json: true,
    temperature: 0.25
  };
}
