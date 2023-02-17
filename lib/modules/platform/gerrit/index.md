# Gerrit

## Authentication

First, ![HTTP access token](/assets/images/gerrit-http-password.png) for the bot account.

Let Renovate use your HTTP access token by doing _one_ of the following:

- Set your HTTP access token as a `password` in your `config.js` file
- Set your HTTP access token as an environment variable `RENOVATE_PASSWORD`
- Set your HTTP access token when you run Renovate in the CLI with `--password=`

Make sure this user is allowed to assign the Code-Review label with "+2" to his own changes or "automerge" can't work.

Remember to set `platform=gerrit` somewhere in your Renovate config file.

## Renovate PR/Branch-Model with Gerrit and needed Permissions

If you use the "Code-Review" label and want `automerge` working, then you have to enable `gerritAutoApprove=true` in your Renovate config.
In this case the bot will automatically add the _Code-Review_ label with the value "+2" to each created "pull-request" (Gerrit-Change).

_Important: The login should be allowed to give +2 for the Code-Review label._

The Renovate option `automergeType: "branch"` makes no sense for Gerrit, because there are no branches used.
It works similar to the default option `"pr"`.

## TODOS

- better comment/msg "Markdown" support, Gerrit 3.7 brings better support, but still no &lt;image&gt; or &lt;details&gt; support
- Images in Markdown-Comments, needs [Gerrit-Feature](https://bugs.chromium.org/p/gerrit/issues/detail?id=2015)

## Features awaiting implementation

- setStability/setConfidence needs platform.setBranchStatus(...), what should we do with this information? Where to store it? As a gerrit-comment/message with special TAG?
- optimize/restructure gerrit-http calls (findPr returns more details then getPr...)

## Unsupported platform features/concepts

- Creating issues (not a gerrit concept) / Renovate-Dashboard.
