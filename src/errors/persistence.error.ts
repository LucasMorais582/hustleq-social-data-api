export class PersistenceError extends Error {
  readonly statusCode = 503;
  readonly code = 'PERSISTENCE_FAILED';

  constructor() {
    super('Não foi possível salvar a coleta. Tente novamente mais tarde.');
  }
}
