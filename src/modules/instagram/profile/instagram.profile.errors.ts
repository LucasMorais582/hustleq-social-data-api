export class ProfileLookupError extends Error {
  readonly statusCode = 404;

  constructor(public readonly code: 'PROFILE_NOT_FOUND' | 'PROFILE_PRIVATE') {
    super(code === 'PROFILE_PRIVATE' ? 'O perfil é privado' : 'Perfil não encontrado');
  }
}
