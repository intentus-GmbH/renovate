import type { CommitFilesConfig } from '../../../util/git/types';
import { GerritScm } from './scm';
import {
  branchExists,
  commitFiles,
  getBranchCommit,
  isBranchBehindBase,
  isBranchConflicted,
  isBranchModified,
} from './';

jest.mock('.', () => {
  const originalModule = jest.requireActual<typeof import('.')>('.');
  return {
    ...originalModule,
    isBranchBehindBase: jest.fn(),
    isBranchModified: jest.fn(),
    isBranchConflicted: jest.fn(),
    branchExists: jest.fn(),
    getBranchCommit: jest.fn(),
    commitFiles: jest.fn(),
  };
});

describe('modules/platform/gerrit/scm', () => {
  it('delegate isBranchBehindBase', async () => {
    await new GerritScm().isBranchBehindBase('branchName', 'main');
    expect(isBranchBehindBase).toHaveBeenCalledWith('branchName', 'main');
  });

  it('delegate isBranchModified', async () => {
    await new GerritScm().isBranchModified('branchName');
    expect(isBranchModified).toHaveBeenCalledWith('branchName');
  });

  it('delegate isBranchConflicted', async () => {
    await new GerritScm().isBranchConflicted('main', 'branchName');
    expect(isBranchConflicted).toHaveBeenCalledWith('main', 'branchName');
  });

  it('delegate branchExists', async () => {
    await new GerritScm().branchExists('branchName');
    expect(branchExists).toHaveBeenCalledWith('branchName');
  });

  it('delegate getBranchCommit', async () => {
    await new GerritScm().getBranchCommit('branchName');
    expect(getBranchCommit).toHaveBeenCalledWith('branchName');
  });

  it('delegate deleteBranch', () => {
    return expect(new GerritScm().deleteBranch('branchName')).toResolve();
  });

  it('delegate commitAndPush', async () => {
    await new GerritScm().commitAndPush({} as CommitFilesConfig);
    expect(commitFiles).toHaveBeenCalledWith({});
  });
});
