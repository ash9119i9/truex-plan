// Task 10: a repeatable quality eval over the same prompts plus edge cases
// (languages, stages, a question-ending answer and hostile agent text).
import { benchConfig, evalSummary, runBench } from "./followups-harness";
import { EVAL_PROMPTS } from "./followups-prompts";

async function main(): Promise<void> {
  const config = benchConfig(process.argv.slice(2), "eval");
  const result = await runBench(config, EVAL_PROMPTS, "eval");
  console.log(
    JSON.stringify({ file: config.out, summary: evalSummary(result) }, null, 2),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
