import { atob } from 'buffer';
import delay from 'delay';
import fs from 'fs-extra';
import JSON5 from 'json5';
import upath from 'upath';
import { GlobalConfig } from '../../../config/global';
import { PlatformId } from '../../../constants';
import { REPOSITORY_ARCHIVED } from '../../../constants/error-messages';
import { logger } from '../../../logger';
import type { VulnerabilityAlert } from '../../../types';
import { BranchStatus, PrState } from '../../../types';
import * as git from '../../../util/git';
import { setRemotePushPrefix } from '../../../util/git/config';
import type { CommitFilesConfig, CommitSha } from '../../../util/git/types';
import { GerritHttp, setBaseUrl } from '../../../util/http/gerrit';
import { ensureTrailingSlash } from '../../../util/url';
import { commitAndPush } from '../commit';
import { smartLinks } from '../gitea/utils';
import type {
  BranchStatusConfig,
  CreatePRConfig,
  EnsureCommentConfig,
  EnsureCommentRemovalConfigByContent,
  EnsureCommentRemovalConfigByTopic,
  EnsureIssueConfig,
  EnsureIssueResult,
  FindPRConfig,
  Issue,
  MergePRConfig,
  PlatformParams,
  PlatformResult,
  Pr,
  RepoParams,
  RepoResult,
  UpdatePrConfig,
} from '../types';
import { repoFingerprint } from '../util';

import { smartTruncate } from '../utils/pr-body';
import type {
  GerritAccountInfo,
  GerritBranchInfo,
  GerritChange,
  GerritChangeMessageInfo,
  GerritFindPRConfig,
  GerritProjectInfo,
} from './types';
import {
  getGerritRepoUrl,
  mapGerritChangeToPr,
  mapPrStateToGerritFilter,
  splitTopicAndBranch,
} from './utils';

const defaults: {
  endpoint?: string;
  hostType: string;
} = {
  hostType: PlatformId.Gerrit,
};

let config: {
  repository?: string;
  head?: string;
  config?: GerritProjectInfo;
} = {};

const gerritHttp = new GerritHttp();

export function initPlatform({
  endpoint,
  username,
  password,
}: PlatformParams): Promise<PlatformResult> {
  logger.info(`initPlatform(${endpoint!}, ${username!})`);
  if (!endpoint) {
    throw new Error('Init: You must configure a Gerrit Server endpoint');
  }
  if (!(username && password)) {
    throw new Error(
      'Init: You must configure a Gerrit Server username/password'
    );
  }
  defaults.endpoint = ensureTrailingSlash(endpoint);
  setBaseUrl(defaults.endpoint);
  setRemotePushPrefix('refs/for/');
  const platformConfig: PlatformResult = {
    endpoint: defaults.endpoint,
  };
  return Promise.resolve(platformConfig);
}

/**
 * Get all state="ACTIVE" and type="CODE" repositories from gerrit
 */
export async function getRepos(): Promise<string[]> {
  logger.debug(`getRepos()`);
  const res = await gerritHttp.getJson(
    'a/projects/?type=CODE&state=ACTIVE',
    {}
  );
  return Promise.resolve(Object.keys(res.body));
}

/**
 * Clone repository to local directory and install the gerrit-commit hook
 * @param config
 */
export async function initRepo({
  repository,
  endpoint,
  gitUrl,
}: RepoParams): Promise<RepoResult> {
  logger.info(`initRepo(${repository}, ${endpoint!}, ${gitUrl!})`);
  const projectInfo = await gerritHttp.getJson<GerritProjectInfo>(
    `a/projects/${encodeURIComponent(repository)}`
  );
  if (projectInfo.body.state !== 'ACTIVE') {
    throw new Error(REPOSITORY_ARCHIVED);
  }
  const branchInfo = await gerritHttp.getJson<GerritBranchInfo>(
    `a/projects/${encodeURIComponent(repository)}/branches/HEAD`
  );
  config = {
    repository,
    head: branchInfo.body.revision,
    config: projectInfo.body,
  };
  const baseUrl = endpoint ?? defaults.endpoint!;
  const url = getGerritRepoUrl(repository, baseUrl);

  // Initialize Git storage
  await git.initRepo({ url });
  await git.syncGit(); //if not called the hook can be removed later...

  // Install Gerrit-Commit-Hook
  const localDir = GlobalConfig.get('localDir')!;
  const gitHooks = upath.join(localDir, '.git/hooks');
  await fs.mkdir(gitHooks, { recursive: true });
  const commitHookData = await gerritHttp.get('tools/hooks/commit-msg');
  await fs.writeFile(`${gitHooks}/commit-msg`, commitHookData.body);
  await fs.chmod(`${gitHooks}/commit-msg`, fs.constants.S_IRWXU);

  // get all open changes from gerrit, then fetch and create local branches with name according to "branchPrefix"
  const openChanges = await findOwnPr({ branchName: '', state: PrState.Open });
  for (const change of openChanges) {
    //abandon "rejected" changes at startup
    const isRejected = await checkForCodeReviewLabel(
      change._number,
      'rejected'
    );
    if (isRejected) {
      await abandonChange(change._number);
      continue;
    }
    const topicSuffix = change.topic ? `%topic=${change.topic}` : '';
    const hashtagSuffix = change.hashtags?.length
      ? `%t=${change.hashtags[0]}`
      : ''; //TODO: what if there are more than one? search for?
    const branchName = `${change.branch}${topicSuffix}${hashtagSuffix}`;
    const remoteRefSpec = `${change.revisions![change.current_revision!].ref}`;
    const localRefSpec = `refs/heads/${branchName}`;
    await git.fetchRevSpec(`${remoteRefSpec}:${localRefSpec}`);
    //TODO/HACK: we create the local branches with the name "origin/" as prefix too. then all util/git/* cmds are should work...
    await git.fetchRevSpec(`${remoteRefSpec}:refs/heads/origin/${branchName}`);
    await git.registerBranch(branchName); //register/cache the branchName
  }

  const repoConfig: RepoResult = {
    defaultBranch: config.head!,
    isFork: false, //TODO: wozu dient das?
    repoFingerprint: repoFingerprint('', url), //TODO: understand the semantic? what cache could be stale/wrong?
  };
  return repoConfig;
}

/**
 * in Gerrit: "Searching Changes"
 *  /changes/?q=$QUERY
 *  QUERY="owner:self+status:$STATE"
 */
async function findOwnPr(
  findPRConfig: GerritFindPRConfig,
  refreshCache?: boolean
): Promise<GerritChange[]> {
  const branchTopic = splitTopicAndBranch(findPRConfig.branchName) ?? {
    branch: findPRConfig.branchName,
    topic: findPRConfig.topic,
    hashtag: findPRConfig.hashtag,
  };
  const topic = findPRConfig.topic ?? branchTopic.topic;
  const hashtag = findPRConfig.hashtag ?? branchTopic.hashtag;
  const filterBranch = branchTopic?.branch && `branch:${branchTopic.branch}`;
  const filterTopic = topic && `topic:${topic}`;
  const filterTag = hashtag && `hashtag:${hashtag}`;
  const filterState = mapPrStateToGerritFilter(findPRConfig.state);
  //const filterTitle = findPRConfig.prTitle ? `message:"${findPRConfig.prTitle}"` : undefined; TODO: check onboarding again without title search...
  const filter = [
    'owner:self',
    'project:' + config.repository!,
    filterState,
    filterTopic,
    filterTag,
    filterBranch,
  ];
  const requestDetails = [
    'SUBMITTABLE',
    'CHECK',
    'CURRENT_ACTIONS',
    'CURRENT_REVISION', //get RevisionInfo::ref to fetch
  ];
  const changes = await gerritHttp.getJson<GerritChange[]>(
    `a/changes/?q=` +
      filter.filter((s) => typeof s !== 'undefined').join('+') +
      requestDetails.map((det) => '&o=' + det).join(''),
    { useCache: !refreshCache }
  );
  logger.info(`findOwnPr(${filter.join(', ')}) => ${changes.body.length}`);
  return changes.body;
}

export async function findPr(
  findPRConfig: FindPRConfig,
  refreshCache?: boolean
): Promise<Pr | null> {
  const change = await findOwnPr(findPRConfig, refreshCache).then((res) =>
    res.pop()
  );
  return change ? mapGerritChangeToPr(change) : null;
}

export async function getPr(number: number): Promise<Pr | null> {
  const changes = await gerritHttp.getJson<GerritChange>(`a/changes/${number}`);
  return Promise.resolve(
    changes.body ? mapGerritChangeToPr(changes.body) : null
  );
}

export async function updatePr(prConfig: UpdatePrConfig): Promise<void> {
  if (prConfig.prBody) {
    await internalChangeUpdate(prConfig.number, prConfig.prBody);
  }
  if (prConfig.state && prConfig.state === PrState.Closed) {
    await abandonChange(prConfig.number);
  }
}

//Abandon Change
async function abandonChange(changeNumber: number): Promise<void> {
  await gerritHttp.postJson(`a/changes/${changeNumber}/abandon`);
}

export async function createPr(prConfig: CreatePRConfig): Promise<Pr | null> {
  logger.info(
    `createPr(${prConfig.sourceBranch}, ${prConfig.prTitle}, ${
      prConfig.labels?.toString() ?? ''
    })`
  );
  let pr = null;
  let retries = 0;
  //Problem: eventual consistency after commit/push to refs/for/$branch to find the change through REST-API, TODO: check if needed
  do {
    pr = await findPr(
      {
        branchName: prConfig.sourceBranch,
        state: PrState.Open,
        prTitle: prConfig.prTitle,
      },
      true
    );
    retries += 1;
    !pr && (await delay(retries * 1000));
  } while (pr === null && retries < 5);
  if (pr) {
    await internalChangeUpdate(pr.number, prConfig.prBody);
    return pr;
  } else {
    //TODO: Problem: what happened?
    return Promise.reject(
      `the change should be created automatically from previous push to refs/for/${prConfig.sourceBranch}`
    );
  }
}

async function internalChangeUpdate(
  changeId: number,
  prBody: string
): Promise<void> {
  const prBodyExists = await checkForExistingMessage(changeId, prBody);
  !prBodyExists &&
    (await gerritHttp.postJson(
      `a/changes/${changeId}/revisions/current/review`,
      { body: { message: prBody, tag: 'pull-request' } }
    ));
  const isApproved = await checkForCodeReviewLabel(changeId, 'approved');
  //TODO: we should only give +2 if "automerge was enabled and the code-review label is available"
  !isApproved &&
    (await gerritHttp.postJson(
      `a/changes/${changeId}/revisions/current/review`,
      { body: { labels: { 'Code-Review': +2 } } }
    ));
}

async function checkForExistingMessage(
  changeId: number,
  newMessage: string
): Promise<boolean> {
  const newMsg = newMessage.trim(); //TODO HACK: the last \n was removed from gerrit after the comment was added?!?
  const messages = await gerritHttp.getJson<GerritChangeMessageInfo[]>(
    `a/changes/${changeId}/messages`,
    { useCache: false }
  );
  return (
    messages.body.find((existingMsg) =>
      existingMsg.message.includes(newMsg)
    ) !== undefined
  );
}

/**
 * check if the Label "Code-Review" not exists or is not approved
 * @param changeId
 * @param labelResult
 */
async function checkForCodeReviewLabel(
  changeId: number,
  labelResult: 'approved' | 'rejected'
): Promise<boolean> {
  const change = await gerritHttp.getJson<GerritChange>(
    `a/changes/${changeId}/detail`,
    { useCache: false }
  );
  const reviewLabels = change?.body.labels && change.body.labels['Code-Review'];
  return reviewLabels === undefined || reviewLabels[labelResult] !== undefined;
}

export async function getBranchPr(branchName: string): Promise<Pr | null> {
  const change = (await findOwnPr({ branchName, state: PrState.Open })).pop();
  if (change) {
    //TODO: should we prefer "late-init" over create local-branches for each open gerrit-change in initRepo()?
    //await git.createBranch(`${change.branch}%topic=${change.topic!}`, change.revisions![change.current_revision!].ref);
    await git.isBranchModified(branchName, config.head); //cache this here, because the "git log .." command will not work because of missing branches
    return mapGerritChangeToPr(change);
  }
  return null;
}

export function getPrList(): Promise<Pr[]> {
  return findOwnPr({ branchName: '' }).then((res) =>
    res.map((change) => mapGerritChangeToPr(change))
  );
}

export async function mergePr(config: MergePRConfig): Promise<boolean> {
  logger.info(
    `mergePr(${config.id}, ${config.branchName!}, ${config.strategy!})`
  );
  const change = await gerritHttp.postJson<GerritChange>(
    `a/changes/${config.id}/submit`
  );
  return change.body.status === 'MERGED';
}

/**
 * BranchStatus for Gerrit: with renovate config "branchPrefix=master%topic="
 *  we require for status="green" that all Changes in this topic are "submittable" or "Verified"?
 * @param branchName
 */
export async function getBranchStatus(
  branchName: string
): Promise<BranchStatus> {
  logger.info(`getBranchStatus(${branchName})`);
  const target = splitTopicAndBranch(branchName);
  const changes = await findOwnPr(
    {
      state: PrState.Open,
      branchName: target?.branch ?? branchName,
      ...(target?.topic && { topic: target.topic }),
      ...(target?.hashtag && { hashtag: target.hashtag }),
    },
    true
  );
  if (changes.length > 0) {
    const allSubmittable =
      changes.filter((change) => change.submittable === true).length ===
      changes.length;
    if (allSubmittable) {
      return BranchStatus.green;
    }
    const hasProblems =
      changes.filter((change) => change.problems && change.problems.length > 0)
        .length > 0;
    if (hasProblems) {
      return BranchStatus.red;
    }
    return BranchStatus.yellow;
  }
  return BranchStatus.yellow; //TODO: after create a new change it's not visible thru rest-api for some time..(eventual consistency)
}

/**
 * @param branchName
 * @param context renovate/stability-days || ...
 */
export function getBranchStatusCheck(
  branchName: string,
  context: string | null | undefined
): Promise<BranchStatus | null> {
  //TODO: what can we do here?
  return getBranchStatus(branchName);
}

/**
 * context === "renovate/stability-days" + state === "green"
 * @param branchStatusConfig
 */
export function setBranchStatus(
  branchStatusConfig: BranchStatusConfig
): Promise<void> {
  //TODO: what can we do here?
  return Promise.resolve();
}

//TODO: where to get the presets? Branch? Parent-Branch? try both...?
export async function getRawFile(
  fileName: string,
  repoName?: string,
  branchOrTag?: string
): Promise<string | null> {
  const repo = repoName?.split('/')[0] ?? config.repository ?? 'All-Projects';
  const branch = branchOrTag ?? config.head;
  const base64Content = await gerritHttp.get(
    `a/projects/${repo}/branches/${branch!}/files/${encodeURIComponent(
      fileName
    )}/content`
  );
  return Promise.resolve(atob(base64Content.body));
}

export async function getJsonFile(
  fileName: string,
  repoName?: string,
  branchOrTag?: string
): Promise<any | null> {
  const raw = (await getRawFile(fileName, repoName, branchOrTag)) as string;
  return JSON5.parse(raw);
}

export function getRepoForceRebase(): Promise<boolean> {
  return Promise.resolve(true);
}

export async function addReviewers(
  number: number,
  reviewers: string[]
): Promise<void> {
  for (const reviewer of reviewers) {
    await gerritHttp.postJson(`a/changes/${number}/reviewers`, {
      body: { reviewer },
    });
  }
}

/**
 * add "CC" (only one possible)
 */
export async function addAssignees(
  number: number,
  assignees: string[]
): Promise<void> {
  await gerritHttp.putJson<GerritAccountInfo>(`a/changes/${number}/assignee`, {
    body: { assignee: assignees[0] },
  });
}

export function deleteLabel(number: number, label: string): Promise<void> {
  //if (pr.labels?.includes(config.rebaseLabel!)) {...
  return Promise.resolve();
}

export async function ensureComment(
  ensureComment: EnsureCommentConfig
): Promise<boolean> {
  logger.info(
    `ensureComment(${ensureComment.number}, ${ensureComment.topic ?? 'null'}, ${
      ensureComment.content
    })`
  );
  const commentExists = await checkForExistingMessage(
    ensureComment.number,
    ensureComment.content
  );
  if (commentExists) {
    return Promise.resolve(true);
  }
  await gerritHttp.postJson(
    `a/changes/${ensureComment.number}/revisions/current/review`,
    {
      body: {
        message: ensureComment.content,
        tag: 'pull-request',
      },
    }
  );
  return true;
}

export function ensureCommentRemoval(
  ensureCommentRemoval:
    | EnsureCommentRemovalConfigByTopic
    | EnsureCommentRemovalConfigByContent
): Promise<void> {
  //TODO: one of the gerrit comment functions?
  return Promise.resolve();
}

export function massageMarkdown(prBody: string): string {
  //TODO: convert to Gerrit-Markdown?
  return smartTruncate(smartLinks(prBody), 16384);
}

/**
 * IMPORTANT: This acts as a wrapper to allow reuse of existing change-id in the commit message.
 * @param config
 */
export async function commitFiles(
  config: CommitFilesConfig
): Promise<CommitSha | null> {
  logger.info(`commitFiles(${config.branchName}, ${config.platformCommit!})`);
  const target = splitTopicAndBranch(config.branchName);
  if (target?.topic || target?.hashtag) {
    //gerrit-commit, try to find existing open change for this topic/hashtag and if found then append the change-id to git-commit-message to replace existing change
    //split config.branchName into branchname and topic/hashtag
    const existingChange = await findOwnPr({
      ...(target.topic && { topic: target.topic }),
      ...(target.hashtag && { hashtag: target.hashtag }),
      branchName: target.branch,
      state: PrState.Open,
    });
    const change = existingChange.pop();
    if (change) {
      const origMsg =
        typeof config.message === 'string' ? [config.message] : config.message;
      config.message = [...origMsg, `Change-Id: ${change.change_id}`];
      if (change.revisions && change.current_revision) {
        //TODO: git.prepareCommit() commits the current dependency update onto current-base-branch,
        // this is like an implicit rebase of the gerrit-change and removes CI (Verified) or other Labels or user-supplied patches to this change.
        // Possibly this should be avoided...we need to compare only the *current* changes from the renovate dependency update
        // with the last one for this dependency, not any other base-branch updates (from renovate for other dependencies or other people).
        // Only if the change is not submittable anymore we can/should do this...
        const commitResult = await git.prepareCommit(config);
        if (commitResult) {
          const { commitSha } = commitResult;
          const fetchRefSpec = change.revisions[change.current_revision].ref;
          await git.fetchRevSpec(fetchRefSpec); //fetch current ChangeSet for git diff
          const hasChanges = await git.hasChanges(['HEAD', 'FETCH_HEAD']);
          if (hasChanges || change.mergeable === false) {
            //something change on base-branch (i.e. other changes were submitted)
            const pushResult = await git.pushCommit(config); //this push is an implicit rebase of the existing change
            if (pushResult) {
              const { branchName } = config;
              await git.registerBranch(branchName);
              return commitSha;
            }
          } else {
            return commitSha;
          }
        } else {
          //empty commit, no changes in this Gerrit-Change
          return change.current_revision;
        }
      }
    }
  }
  return await commitAndPush({ ...config, platformCommit: false });
}

export function ensureIssueClosing(title: string): Promise<void> {
  return Promise.resolve();
}

export function ensureIssue(
  issueConfig: EnsureIssueConfig
): Promise<EnsureIssueResult | null> {
  return Promise.resolve(null);
}

export function findIssue(title: string): Promise<Issue | null> {
  logger.warn(`findIssue() is not implemented`);
  return Promise.resolve(null);
}

export function getIssueList(): Promise<Issue[]> {
  return Promise.resolve([]);
}

export function getVulnerabilityAlerts(): Promise<VulnerabilityAlert[]> {
  return Promise.resolve([]);
}
