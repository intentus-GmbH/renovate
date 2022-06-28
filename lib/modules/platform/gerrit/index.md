# Gerrit

## Authentication

First, ![HTTP access token](gerrit-http-password.png) for the bot account.

Let Renovate use your HTTP access token by doing _one_ of the following:

- Set your HTTP access token as a `password` in your `config.js` file
- Set your HTTP access token as an environment variable `RENOVATE_PASSWORD`
- Set your HTTP access token when you run Renovate in the CLI with `--password=`

Make sure this user is allowed to assign the Code-Review label with "+2" to his own changes or "automerge" can't work.

Remember to set `platform=gerrit` somewhere in your Renovate config file.

## Branch-Model with Gerrit and needed Permissions

The renovate user needs permission to create, push and delete references to refs/renovate/\*.

Example `project.config` permission snippet

```
[access "refs/renovate/*"]
	read = group Renovate
	create = group Renovate
	push = +force group Renovate
	pushMerge = group Renovate
	delete = group Renovate
```

The dependency updates were created and pushed to newly create branches with the configured branchPrefix (defaults to renovate/). These create/update/delete operations needs to be permitted to the renovate user as shown in the above snippet.
The branches are outside of refs/heads and therefore invisible to the default fetch-RefSpecs from users.

After the branch were created/pushed the top-commit (i.e. the commit that contains the dependency-update) was cherry-picked to the configured target branch as a review/pull-request. The sourceBranch was saved as a hashtag in these gerrit-change for further lookups (getBranchPr, getBranchStatus, ..).

```
{
  platformCommit: true, //allow reuse the Change-Id and implicit rebase of existing changes
  gitNoVerify: ["push"], //allow-commit-hook
}
```

## Unsupported platform features/concepts

- Creating issues (not a gerrit concept) / Dashboard.

## Features awaiting implementation

- convert "pull-request" body to Gerrits "Markdown" Syntax
- Adding/removing labels
- The `automergeStrategy` configuration option has not been implemented for this platform, and all values behave as if the value `auto` was used. Renovate will use the merge strategy configured in the Gerrit repository itself, and this cannot be overridden yet
- Fill pr.bodyStruct.rebaseRequested , see shouldReuseExistingBranch()
- Fill pr.bodyStruct.hash to avoid unnecessary updatePr() calls
-
