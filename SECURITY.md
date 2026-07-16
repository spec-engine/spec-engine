# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, report them privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability):
open the repository's **Security** tab and choose **Report a vulnerability**.

Include:

- A description of the issue and its impact
- Steps to reproduce (a minimal command sequence or fixture is ideal)
- Any relevant version or environment details

We'll acknowledge your report, work with you on a fix, and coordinate disclosure.

## Scope

spec-check is a local developer tool: it reads a working directory of repos, builds a
disposable local index, and writes spec files you author. It makes no network calls in
normal operation and stores no credentials. Reports most relevant here involve path
traversal, unsafe file writes outside the platform directory, or injection through spec
content or `@spec` tags.

## Supported versions

This is a pre-1.0 proof-of-concept; only the latest `main` is supported.
