export class CompetitorError extends Error {
  constructor(
    public readonly statusCode: 400 | 404 | 409,
    public readonly code:
      | 'COMPETITOR_CONFIRMATION_INVALID'
      | 'COMPETITOR_SELF_REFERENCE'
      | 'PROFILE_NOT_FOUND'
      | 'COMPETITOR_PROFILE_NOT_FOUND'
      | 'COMPETITOR_ALREADY_ACTIVE'
      | 'COMPETITOR_LIMIT_REACHED'
      | 'COMPETITOR_RELATION_NOT_FOUND',
    message: string,
  ) {
    super(message);
  }
}
