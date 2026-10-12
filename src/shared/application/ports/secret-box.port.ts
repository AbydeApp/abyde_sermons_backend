export const SECRET_BOX = Symbol('SECRET_BOX');

/** Authenticated encryption for credentials stored at rest (integration tokens). */
export interface SecretBoxPort {
  seal(plaintext: string): string;
  open(sealed: string): string;
}

export const TOKEN_GENERATOR = Symbol('TOKEN_GENERATOR');

/** Opaque bearer secrets (session cookies, reset tokens): only the hash is ever persisted. */
export interface TokenGeneratorPort {
  generate(): { token: string; hash: string };
  hash(token: string): string;
}
