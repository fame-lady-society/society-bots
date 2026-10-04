export class AuthorityError extends Error {
  constructor(readonly status: 401 | 403 | 404) {
    super(
      status === 401 ? "Sign in required." : "Your permissions have changed.",
    );
  }
}
export async function apiFetch(path: string, init?: RequestInit) {
  const response = await fetch(path, init);
  if (response.status === 401 || response.status === 403)
    throw new AuthorityError(response.status);
  return response;
}

export async function runtimeFetch(path: string, init?: RequestInit) {
  const response = await apiFetch(path, init);
  if (response.status === 404) throw new AuthorityError(404);
  return response;
}
