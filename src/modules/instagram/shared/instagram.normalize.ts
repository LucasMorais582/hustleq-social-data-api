import { ProviderError } from '../../../errors/provider.error.js';

export function normalizeMediaType(
  type: string | null | undefined,
  productType?: string | null,
): 'photo' | 'carousel' | 'reel' {
  if (productType?.trim().toLowerCase() === 'clips') return 'reel';
  switch (type?.trim().toLowerCase()) {
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
        .map((tag) => tag.trim().replace(/^#+/, '').trim().toLowerCase())
        .filter((tag) => /\p{L}/u.test(tag)),
    ),
  ];
}

export function toMvpMediaType(type: 'photo' | 'carousel' | 'reel') {
  return ({ photo: 'IMAGE', carousel: 'CAROUSEL', reel: 'REEL' } as const)[type];
}

export function normalizeProfileName(value: string | null | undefined) {
  return value?.trim() ? value : null;
}
