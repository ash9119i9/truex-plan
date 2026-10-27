// Task 1: measure block compliance on the real models before building on the
// format. Writes a dated results file and prints the keep/exclude summary.
import { benchConfig, probeSummary, runBench } from "./followups-harness";
import { PROBE_PROMPTS } from "./followups-prompts";

async function main(): Promise<void> {
  const config = benchConfig(process.argv.slice(2), "probe");
  const result = await runBench(config, PROBE_PROMPTS, "probe");
  console.log(
    JSON.stringify(
      { file: config.out, summary: probeSummary(result) },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
