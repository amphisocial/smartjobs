import { diagnoseJobSearchProvider } from "../lib/job-search-engine.js";

const query = process.argv.slice(2).join(" ").trim() || 'technology jobs "Boston, MA" careers';
const result = await diagnoseJobSearchProvider(query);
console.log(JSON.stringify({ query, ...result }, null, 2));
if (!result.ok) process.exitCode = 1;
