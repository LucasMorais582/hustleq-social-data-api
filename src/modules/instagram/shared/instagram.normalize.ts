import { ProviderError } from '../../../errors/provider.error.js';

export function normalizeMediaType(type: string | null | undefined): 'photo' | 'carousel' | 'reel' {
  switch (type?.toLowerCase()) {
    case 'image':
    case 'photo':
      return 'photo';
    case 'sidecar':
    case 'carousel':
      return 'carousel';
    case 'video':
    case 'reel':
      return 'reel';
    default:
      throw new ProviderError(
        503,
        'PROVIDER_INVALID_RESPONSE',
        'Tipo de mídia desconhecido no retorno do provedor',
      );
  }
}

export function normalizeHashtags(hashtags: string[] | null | undefined) {
  return [
    ...new Set(
      (hashtags ?? [])
        .map((tag) => tag.trim().replace(/^#+/, ''))
        .filter((tag) => /\p{L}/u.test(tag)),
    ),
  ];
}
