import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../../provider/database/prisma.client.js';
import { providerFailure } from '../../../errors/provider.error.js';
import {
  ProviderStartUncertain,
  type TrackedRunGateway,
} from '../../../provider/apify/apify.tracked-run.js';
import { normalizeProfileName } from '../shared/instagram.normalize.js';
import { lookupTrackedInstagramProfile } from './instagram.profile.lookup.service.js';
import { ProfileLookupError } from './instagram.profile.errors.js';
import { readInstagramProfileOwnership } from './instagram.profile.search.repository.js';
import {
  instagramProfileSearchQuerySchema,
  instagramProfileSearchResponseSchema,
} from './instagram.profile.search.schemas.js';

export async function searchInstagramProfile(
  request: { username: string },
  userId: string,
  client: PrismaClient = getPrismaClient(),
  gateway?: TrackedRunGateway,
) {
  const input = instagramProfileSearchQuerySchema.parse(request);
  try {
    const { profile } = await lookupTrackedInstagramProfile(
      input.username,
      { trigger: 'search', userId },
      client,
      gateway,
    );
    const ownershipStatus = await readInstagramProfileOwnership(profile.id, userId, client);
    return instagramProfileSearchResponseSchema.parse({
      instagramId: profile.id,
      username: profile.username,
      name: normalizeProfileName(profile.fullName),
      bio: profile.biography ?? null,
      profilePhoto: profile.profilePicUrlHD ?? profile.profilePicUrl ?? null,
      isVerified: profile.verified ?? null,
      followers: profile.followersCount ?? null,
      following: profile.followsCount ?? null,
      postsCount: profile.postsCount ?? null,
      ownershipStatus,
    });
  } catch (error) {
    if (error instanceof ProfileLookupError && error.code === 'PROFILE_NOT_FOUND') {
      return { username: input.username, ownershipStatus: 'not_found' as const };
    }
    if (error instanceof ProviderStartUncertain)
      throw providerFailure('Não foi possível confirmar o início da pesquisa na Apify');
    throw error;
  }
}
