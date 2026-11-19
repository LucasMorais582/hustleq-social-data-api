import { lookupInstagramProfile } from '../profile/instagram.profile.service.js';
import {
  createCompetitorConfirmation,
  readCompetitorConfirmation,
} from './instagram.competitors.confirmation.js';
import { PersistenceError } from '../../../errors/persistence.error.js';
import { CompetitorError } from './instagram.competitors.errors.js';
import {
  withCompetitorTransaction,
  type CompetitorStatus,
  type CompetitorStore,
} from './instagram.competitors.repository.js';

async function execute<T>(work: (store: CompetitorStore) => Promise<T>): Promise<T> {
  try {
    return await withCompetitorTransaction(work);
  } catch (error) {
    if (error instanceof CompetitorError) throw error;
    throw new PersistenceError();
  }
}

async function requireProfile(store: CompetitorStore, profileId: string) {
  if (!(await store.profileExists(profileId))) {
    throw new CompetitorError(404, 'PROFILE_NOT_FOUND', 'O perfil monitorador não está cadastrado');
  }
}

async function validateActiveCompetitor(
  store: CompetitorStore,
  profileId: string,
  competitorId: string,
) {
  if (await store.activeExists(profileId, competitorId)) {
    throw new CompetitorError(
      409,
      'COMPETITOR_ALREADY_ACTIVE',
      'Este concorrente já está ativo para o perfil',
    );
  }
  if ((await store.countActive(profileId)) >= 3) {
    throw new CompetitorError(
      409,
      'COMPETITOR_LIMIT_REACHED',
      'O perfil já possui três concorrentes ativos',
    );
  }
}

export async function addInstagramCompetitor(profileId: string, competitorId: string) {
  if (profileId === competitorId) {
    throw new CompetitorError(
      400,
      'COMPETITOR_SELF_REFERENCE',
      'Um perfil não pode monitorar a si mesmo',
    );
  }
  return execute(async (store) => {
    await requireProfile(store, profileId);
    if (!(await store.profileExists(competitorId))) {
      throw new CompetitorError(
        404,
        'COMPETITOR_PROFILE_NOT_FOUND',
        'O perfil concorrente não está cadastrado',
      );
    }
    await validateActiveCompetitor(store, profileId, competitorId);
    return store.create(profileId, competitorId);
  });
}

export async function listInstagramCompetitors(
  profileId: string,
  status: CompetitorStatus,
  page: number,
  limit: number,
) {
  return execute(async (store) => {
    await requireProfile(store, profileId);
    const relations = await store.list(profileId, status, (page - 1) * limit, limit);
    return { relations, page, limit };
  });
}

export async function endInstagramCompetitor(profileId: string, relationId: string) {
  return execute(async (store) => {
    await requireProfile(store, profileId);
    const relation = await store.find(profileId, relationId);
    if (!relation) {
      throw new CompetitorError(
        404,
        'COMPETITOR_RELATION_NOT_FOUND',
        'Relação de concorrência não encontrada neste perfil',
      );
    }
    // Repetir a remoção não altera o instante de encerramento do histórico.
    return relation.endedAt ? relation : store.end(relationId, new Date());
  });
}

export async function previewInstagramCompetitor(
  profileId: string,
  username: string,
  subject: string,
) {
  const instagramId = await execute(async (store) => {
    await requireProfile(store, profileId);
    return store.profileInstagramId(profileId);
  });
  const item = await lookupInstagramProfile({ username });
  if (item.id === instagramId) {
    throw new CompetitorError(
      400,
      'COMPETITOR_SELF_REFERENCE',
      'Um perfil não pode monitorar a si mesmo',
    );
  }
  const profile = {
    instagramId: item.id,
    username: item.username,
    name: item.fullName ?? null,
    bio: item.biography ?? null,
    profilePhoto: item.profilePicUrlHD ?? item.profilePicUrl ?? null,
    url: item.url ?? null,
    category: item.businessCategoryName ?? null,
    isVerified: item.verified ?? null,
  };
  return { profile, ...createCompetitorConfirmation(profileId, subject, profile) };
}

export async function confirmInstagramCompetitor(
  profileId: string,
  token: string,
  subject: string,
) {
  const profile = readCompetitorConfirmation(token, profileId, subject);
  return execute(async (store) => {
    await requireProfile(store, profileId);
    if ((await store.profileInstagramId(profileId)) === profile.instagramId) {
      throw new CompetitorError(
        400,
        'COMPETITOR_SELF_REFERENCE',
        'Um perfil não pode monitorar a si mesmo',
      );
    }
    const competitorId = await store.saveIdentity(profile);
    // Todas as regras e a gravação do perfil pertencem à mesma transação.
    await validateActiveCompetitor(store, profileId, competitorId);
    return store.create(profileId, competitorId);
  });
}
