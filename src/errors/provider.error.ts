export class ProviderError extends Error {
  constructor(
    public readonly statusCode: 429 | 503,
    public readonly code:
      'PROVIDER_RATE_LIMITED' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_INVALID_RESPONSE',
    message: string,
  ) {
    super(message);
  }
}

export function isProviderRateLimit(message: string) {
  return /rate[ _-]?limit|please wait|quota|too many|(?:daily|monthly|usage|execution|account) limit|credits? (?:exhausted|insufficient)|insufficient credits|free tier.{0,60}(?:refused|exceeded|cooldown)/i.test(
    message,
  );
}

export function providerFailure(message: string, statusCode?: number) {
  const limited = statusCode === 429 || isProviderRateLimit(message);
  return new ProviderError(
    limited ? 429 : 503,
    limited ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_UNAVAILABLE',
    message,
  );
}
