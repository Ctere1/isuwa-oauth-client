/** The scope the connector endpoints require. */
export const DEFAULT_SCOPE = 'app:read';

/** The endpoints every application shares, whatever connector it is registered as. */
export const PATHS = {
  token: '/api/v1/oauth/token',
  jwks: '/api/v1/oauth/jwks.json',
} as const;

/** The audience an issued access token carries. */
export const TOKEN_AUDIENCE = 'isuwa-iam-application';
