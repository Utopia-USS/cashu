// The test process env without the variables each shim test sets itself (tests only).

/** The process env without any CASHU_ / FINANSE_ variable or XDG_DATA_HOME (each test sets its own). */
export function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CASHU_") || key.startsWith("FINANSE_") || key === "XDG_DATA_HOME") {
      delete env[key];
    }
  }
  return env;
}
