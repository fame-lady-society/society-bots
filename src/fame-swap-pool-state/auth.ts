export function poolStateRequestAuthorized(
  headers: Record<string, string | undefined>,
  serviceToken: string,
): boolean {
  const authorization = headers.authorization ?? headers.Authorization;
  return authorization === `Bearer ${serviceToken}`;
}
