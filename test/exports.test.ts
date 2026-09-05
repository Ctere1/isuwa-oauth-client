import { describe, expect, it } from 'vitest';

import { IsuwaClient } from '../src/client.js';
import * as sdk from '../src/index.js';

describe('package exports', () => {
  it('exports the client as both a name and the default', () => {
    expect(sdk.IsuwaClient).toBe(IsuwaClient);
    expect(sdk.default).toBe(IsuwaClient);
  });

  it('no longer ships the 1.x client', () => {
    expect('OAuthClient' in sdk).toBe(false);
  });

  it('stays an OAuth2 client, with nothing connector-specific in it', () => {
    for (const name of [
      'WebConnector',
      'DECISION_CODE',
      'WEB_AUTH_STATUS',
      'isAccept',
      'isChallenge',
      'passwordAuth',
    ]) {
      expect(name in sdk, name).toBe(false);
    }
  });

  it('exports the pieces an application needs', () => {
    for (const name of [
      'IsuwaClient',
      'JwksVerifier',
      'TokenManager',
      'jwkToPem',
      'DEFAULT_SCOPE',
      'PATHS',
      'TOKEN_AUDIENCE',
      'MIN_TIMEOUT_MS',
      'IsuwaError',
      'IsuwaConfigError',
      'IsuwaOAuthError',
      'IsuwaRateLimitError',
      'IsuwaHttpError',
      'IsuwaTimeoutError',
      'IsuwaNetworkError',
      'IsuwaTokenVerificationError',
    ]) {
      expect(sdk, name).toHaveProperty(name);
    }
  });
});
