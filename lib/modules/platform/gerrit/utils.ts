import { PlatformId } from '../../../constants';
import { CONFIG_GIT_URL_UNAVAILABLE } from '../../../constants/error-messages';
import { logger } from '../../../logger';
import { PrState } from '../../../types';
import * as hostRules from '../../../util/host-rules';
import { parseUrl } from '../../../util/url';
import type { Pr } from '../types';
import type { GerritChange } from './types';

export function getGerritRepoUrl(repository: string, endpoint: string): string {
  // Find options for current host and determine Git endpoint
  const opts = hostRules.find({
    hostType: PlatformId.Gerrit,
    url: endpoint,
  });

  const url = parseUrl(endpoint);
  if (!url) {
    throw new Error(CONFIG_GIT_URL_UNAVAILABLE);
  }
  url.protocol = url.protocol?.slice(0, -1) ?? 'https';
  url.username = opts.username ?? '';
  url.password = opts.password ?? '';
  url.pathname = `a/${repository}`;
  logger.debug(
    { url: url.toString() },
    'using URL based on configured endpoint'
  );
  return url.toString();
}

export function splitTopicAndBranch(
  branchNameWithTopic?: string
): { branch: string; topic?: string; hashtag?: string } | undefined {
  if (branchNameWithTopic?.includes('%topic=')) {
    const res = branchNameWithTopic.split(/%topic=/);
    return { branch: res[0], topic: res[1] };
  }
  if (branchNameWithTopic?.includes('%t=')) {
    const res = branchNameWithTopic.split(/%t=/);
    return { branch: res[0], hashtag: res[1] };
  }
  return undefined;
}

export function mapPrStateToGerritFilter(state?: PrState): string {
  switch (state) {
    case PrState.Closed:
      return 'status:closed';
    case PrState.Merged:
      return 'status:merged';
    case PrState.NotOpen:
      return '-status:open';
    case PrState.Open:
      return 'status:open';
    case PrState.All:
    default:
      return '-is:wip';
  }
}

export function mapGerritChangeStateToPrState(
  state: 'NEW' | 'MERGED' | 'ABANDONED'
): PrState {
  switch (state) {
    case 'NEW':
      return PrState.Open;
    case 'MERGED':
      return PrState.Merged;
    case 'ABANDONED':
      return PrState.Closed;
  }
  return PrState.All;
}

export function mapGerritChangeToPr(change: GerritChange): Pr {
  return {
    number: change._number,
    state: mapGerritChangeStateToPrState(change.status),
    sourceBranch: change.branch,
    targetBranch: change.branch,
    title: change.subject,
    hasReviewers: change.reviewers !== undefined,
  };
}
