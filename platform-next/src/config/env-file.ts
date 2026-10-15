// Loads .env when present; real deployments set the environment directly.
export function loadEnvFileIfPresent(): void {
  try {
    process.loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
