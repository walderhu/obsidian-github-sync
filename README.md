# GitHub Vault Sync

An Obsidian community plugin for two-way vault synchronization through the GitHub Contents/Git Data APIs. It works on desktop and Obsidian Mobile, including iPhone, without shell access or a local Git client.

## Features

- Pulls and pushes files through GitHub's Git API.
- Uses SHA-1 blob hashes to detect local-only, remote-only, and simultaneous edits.
- Creates a `*.conflict-remote-YYYYMMDD-HHmmss` copy instead of silently overwriting a simultaneous edit.
- Stores only the last synchronized manifest in plugin data; the GitHub token is never committed to the repository.
- Supports manual sync, sync on vault open, and a configurable interval while Obsidian is open.
- Lets each device use a different local configuration folder by default; vault content and attachments are synchronized.

## Install with BRAT

1. Install **BRAT** from Obsidian Community Plugins.
2. Add `walderhu/obsidian-github-sync` as a beta plugin.
3. Enable **GitHub Vault Sync**.

## Setup

Create a GitHub fine-grained token with **Contents: Read and write** access to the vault repository. Do not put the token in notes or Git. In Obsidian settings, enter the owner, repository, branch, and token, then run **GitHub Vault Sync: Sync now**.

The first sync is conservative. If both the local vault and GitHub contain different versions of a file and no previous manifest exists, the local file remains at its path and the GitHub version is written as a conflict copy.

## Safety

Make a backup before the first sync. GitHub API limits apply, and files larger than GitHub's supported blob limits cannot be synchronized. Do not run another sync service against the same vault at the same time.
