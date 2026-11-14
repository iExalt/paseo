interface E2EWebEnvironment {
  [key: string]: string | undefined;
  E2E_BASE_URL?: string;
  E2E_WEB_BASE_URL?: string;
}

export function getE2EWebBaseURL(
  port: number,
  environment: E2EWebEnvironment = process.env,
): string {
  return environment.E2E_BASE_URL ?? environment.E2E_WEB_BASE_URL ?? `http://127.0.0.1:${port}`;
}

export function getE2EWebOrigin(
  port: number,
  environment: E2EWebEnvironment = process.env,
): string {
  return new URL(getE2EWebBaseURL(port, environment)).origin;
}
