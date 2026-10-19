export const ACCESS_TOKEN_SIGNER = Symbol('ACCESS_TOKEN_SIGNER');

export interface AccessTokenClaims {
  userId: string;
  sessionId: string;
}

/** Issues and checks short-lived access tokens without touching storage. */
export interface AccessTokenSigner {
  sign(claims: AccessTokenClaims, issuedAt: Date, expiresAt: Date): string;
  /** Null when the token is malformed, tampered with or expired. */
  verify(token: string, now: Date): AccessTokenClaims | null;
}
