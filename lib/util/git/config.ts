import is from '@sindresorhus/is';
import type { SimpleGitOptions } from 'simple-git';
import { GlobalConfig } from '../../config/global';
import type { GitNoVerifyOption } from './types';

let noVerify: GitNoVerifyOption[] = ['push', 'commit'];

export function setNoVerify(value: GitNoVerifyOption[]): void {
  // istanbul ignore if
  if (!is.array(value, is.string)) {
    throw new Error('config error: gitNoVerify should be an array of strings');
  }
  noVerify = value;
}

export function getNoVerify(): GitNoVerifyOption[] {
  return noVerify;
}

//TODO: could this defaults to "refs/heads/"?
// Should this be an array to allow multiple refspecs to fetch like ['refs/heads/', 'refs/renovate/'] ?
let remoteBranchRefSpec = '';

export function getRemoteBranchRefSpec(): string {
  return remoteBranchRefSpec;
}

export function setRemoteBranchRefSpec(refSpec: string): void {
  remoteBranchRefSpec = refSpec;
}

export function simpleGitConfig(): Partial<SimpleGitOptions> {
  const config: Partial<SimpleGitOptions> = {
    completion: {
      onClose: true,
      onExit: false,
    },
  };
  // https://github.com/steveukx/git-js/pull/591
  const gitTimeout = GlobalConfig.get('gitTimeout');
  if (is.number(gitTimeout) && gitTimeout > 0) {
    config.timeout = { block: gitTimeout };
  }
  return config;
}
